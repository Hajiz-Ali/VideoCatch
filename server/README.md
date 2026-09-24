# VideoCatch — Universal Video Downloader (backend)

Production-shaped backend for the VideoCatch frontend. Accepts a video URL, extracts the
**real** available media streams from the source site, and streams a finished file back
to the user.

The extraction layer is **not mocked** — it shells out to [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
(via argument arrays, never shell strings) and merges/remuxes with `ffmpeg`. Format
options, resolutions, sizes and qualities are derived strictly from what the extractor
actually reports. No quality is ever invented or upscaled.

---

## Flow

```text
Frontend sends URL
        ↓
POST /v1/analyze        →  URL guard (SSRF + allowlist) → yt-dlp extracts real
                           title/thumbnail/duration + genuine format list
        ↓
User picks quality (or BEST)
        ↓
POST /v1/download       →  validates format → enqueues a job (concurrency-limited)
        ↓
GET  /v1/progress/:jobId →  downloads streams, merges video+audio (ffmpeg)
        ↓
GET  /api/files/:jobId/:token →  streams the finished file (untraceable URL)
```

---

## Project structure

```text
server/
├── package.json
├── .env.example          # copy to .env and configure
├── scripts/
│   └── e2e-live.mjs      # live end-to-end check against a real video
├── src/
│   ├── index.js          # entry point (loads .env, starts server)
│   ├── app.js            # Express assembly, routing, middleware wiring
│   ├── config.js         # env parsing / validation
│   ├── logger.js         # leveled, JSON-line logger (console + optional file)
│   ├── paths.js          # data/work/files directory bootstrap
│   ├── lib/
│   │   ├── urls.js       # URL validation + SSRF guard + ApiError
│   │   ├── formats.js    # maps yt-dlp JSON → frontend format options (no fakes)
│   │   ├── binaries.js   # locates yt-dlp / ffmpeg (cached)
│   │   └── cleanup.js    # TTL sweeper for jobs, work dirs and old files
│   ├── middleware/
│   │   ├── rateLimit.js  # per-IP fixed-window limiter
│   │   ├── security.js   # body/format validation, safety headers
│   │   └── errors.js     # centralized error handler (never leaks paths)
│   ├── sources/          # pluggable extraction layer
│   │   ├── base.js       # BaseSource interface
│   │   └── registry.js   # source registry + registration point
│   ├── services/
│   │   ├── ytdlp.js      # subprocess runner with timeout + error mapping
│   │   ├── analyzer.js   # analyze endpoint logic (+ small cache)
│   │   ├── downloader.js # download + merge orchestration + progress parsing
│   │   └── jobManager.js # queue, concurrency limit, state, file staging
│   └── routes/
│       ├── analyze.js
│       ├── download.js
│       ├── progress.js
│       └── files.js
├── test/                 # node:test suites (unit + integration)
│   ├── urls.test.mjs
│   ├── formats.test.mjs
│   └── integration.test.mjs
└── data/                 # runtime (gitignored): work/ + files/
```

---

## Requirements

| Tool | Why | Install (Windows) |
| --- | --- | --- |
| **Node.js ≥ 20** | runtime | https://nodejs.org |
| **yt-dlp** | real extraction + download | `py -m pip install --user yt-dlp` (or the [standalone exe](https://github.com/yt-dlp/yt-dlp/releases)) |
| **ffmpeg** | merging video+audio / remux MP4 | `winget install Gyan.FFmpeg` or the [gyan.dev builds](https://www.gyan.dev/ffmpeg/builds/). It must be on `PATH` or set via `FFMPEG_BINARY` |

The server auto-discovers `yt-dlp` / `ffmpeg` on `PATH` (including `.exe` on Windows).
If they are missing, the API still runs and `/health` reports the gap, but analyze/download
return a clear error telling the user to ask the admin to install them.

> To confirm your tools work: `yt-dlp --version` and `ffmpeg -version`.

---

## Setup

```bash
cd server
npm install
cp .env.example .env          # then edit the values (at minimum the binaries)
npm start                     # starts on http://localhost:8787
```

For development: `npm run dev` (auto-restarts on file changes).

### Frontend integration

The frontend (`index.html` at the project root) talks to the backend on three paths:

```js
// frontend CONFIG
const CONFIG = {
  API_BASE_URL: "http://localhost:8787", // ← point this at the server
  ANALYZE_PATH: "/v1/analyze",           // served natively
  DOWNLOAD_PATH: "/v1/download",
  PROGRESS_PATH: "/v1/progress",
};
```

`SERVE_FRONTEND=true` (default) also serves the static frontend directly from the API
root — open `http://localhost:8787/` with the frontend’s `API_BASE_URL` kept empty/relative.

---

## API reference

All endpoints return JSON. Errors use this shape (status + code + safe message):

```json
{ "error": { "code": "UNSUPPORTED_SITE", "message": "This website is not currently supported..." } }
```

`/api/...` and `/v1/...` are aliases — the frontend uses `/v1`.

### `POST /v1/analyze`

```json
{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
```

Success `200` — includes **only data that was actually detected** (a field is omitted when the
extractor did not report it):

```jsonc
{
  "url": "https://www.youtube.com/watch?v=...",
  "title": "Rick Astley - Never Gonna Give You Up",
  "source": "YouTube",
  "thumbnailUrl": "https://i.ytimg.com/.../hqdefault.jpg",
  "durationSeconds": 212,
  "formats": [
    {
      "quality": "1080p",       // derived ONLY from the stream's real height (+fps)
      "container": "mp4",       // container we can produce ("mp4"|"webm"|"mkv")
      "ext": "mp4",
      "fileSizeBytes": 84500000,// real or bitrate-estimated; null if unknown
      "formatId": "137+140",    // id you must send back to /download
      "audio": true,            // whether the resulting file includes audio
      "video": true
    }
  ],
  "bestFormatId": "137+140"     // genuinely highest-res; prefers MP4-compatible
}
```

`240p`, `1080p`, `4k` etc. are only ever produced when the site really offers that stream.
Video-only streams are paired with the best matching audio (mp4-family audio for mp4 video,
opus for webm) so merged results stay in the native container.

Common errors: `400 INVALID_URL`, `400 SSRF_BLOCKED`, `422 DNS_FAILED`, `422 UNSUPPORTED_SITE`,
`422 NO_FORMATS`, `500 BINARY_MISSING`.

### `POST /v1/download`

```json
{ "url": "https://www.youtube.com/watch?v=...", "formatId": "137+140" }
```

Success `202`:

```json
{ "jobId": "6842c8e4-cf5f-44cf-a1fb-340c9d895297" }
```

The job is queued and processed under `MAX_CONCURRENT_DOWNLOADS`. If the queue is full:
`429 SERVER_BUSY`.

### `GET /v1/progress/:jobId`

Polls an in-flight job:

```jsonc
// queued / processing:
{ "jobId": "...", "status": "processing", "percent": 47, "message": "Downloading…" }
// completed:
{ "jobId": "...", "status": "completed", "percent": 100, "message": "Complete",
  "downloadUrl": "/api/files/<jobId>/<random-token>", "fileName": "...mp4" }
// failed:
{ "jobId": "...", "status": "failed", "percent": 0, "error": "safe user-facing message" }
```

`status` is one of `queued | processing | completed | failed`. Unknown jobs → `404`.

### `GET /api/files/:jobId/:token`

Streams the finished file. The token is a 192-bit random secret issued per job, so downloads
cannot be guessed. Supports HTTP Range requests. The job record (and its file) is removed
after `JOB_TTL_MS` / `FILE_TTL_MS` by the sweeper.

### `GET /health`

```json
{ "ok": true, "extractor": { "ytDlp": true, "ffmpeg": true }, "downloadsActive": 0 }
```

---

## Reliability & security model

- **Honest extraction** — everything the API returns comes from the extractor’s real output.
  No sample videos, no fake formats, no upscaling claims.
- **Input validation** — every body is checked (type, required fields, max length); URLs must be
  `http(s)` with valid characters; format ids must match a strict character whitelist.
- **SSRF protection** — every URL’s hostname is DNS-resolved and rejected if **any** address is
  private/reserved (loopback, link-local incl. `169.254.169.254`, CGNAT, `192.168/16`, RFC1918,
  IPv6 ULA/LLA/mapped, multicast…). On top of that a **domain allowlist** (configurable via
  `ALLOWED_DOMAINS`) limits extraction to known video sites; `ALLOW_ALL_HOSTS=true` disables the
  list but **never** the IP guard.
- **No command injection** — yt-dlp is spawned with argument arrays (`windowsHide`, no shell).
  Only server-controlled flags reach the command line; user-controlled values are validated
  before being passed as arguments.
- **Boundaries & overload control** — per-IP rate limits on analyze/download/progress, a capped
  download queue, `MAX_CONCURRENT_DOWNLOADS/Analyzes`, per-format size cap and a hard
  `--max-filesize`, plus timeouts on every subprocess that kill hung jobs.
- **Isolation & cleanup** — every job writes to its own random `data/work/<jobId>` directory;
  the directory (including `.part` files) is removed on success **and** on failure. Completed
  files live in `data/files/` and are garbage-collected by the sweeper (also removes stale
  orphaned work dirs after a crash).
- **No path leaks / arbitrary-file access** — files are only served through the tokenised URL
  and are cross-checked to be inside `data/files/`. Error responses never include filesystem
  paths (internal details go only to the server log).
- **Access controls** — DRM, paywalls, geo-blocks are never bypassed (no `--geo-bypass`, no DRM
  hacks). Authorised private content works only if the admin provides cookies via
  `YT_DLP_COOKIES_FILE`.

---

## Configuration reference

All options come from environment variables (via `.env`). See `.env.example` for the
full annotated list. Key ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | HTTP listener |
| `YT_DLP_BINARY` / `FFMPEG_BINARY` | auto | Override the binary path/name |
| `YT_DLP_COOKIES_FILE` | — | Netscape cookies for admin-authorized private content |
| `YT_DLP_EXTRA_ARGS` | — | Extra yt-dlp flags (admin only) |
| `ALLOWED_DOMAINS` | built-in list | Comma-separated extraction allowlist |
| `ALLOW_ALL_HOSTS` | `false` | Allow any public host (IP guard stays on) |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Parallel job cap |
| `MAX_QUEUE_LENGTH` | `100` | Queue cap before `429` |
| `MAX_FORMAT_SIZE_BYTES` | `4 GiB` | Per-stream cap (0 = off) |
| `MAX_DOWNLOAD_SIZE_BYTES` | `0` | Hard final-file cap via `--max-filesize` |
| `ANALYZE_TIMEOUT_MS` / `DOWNLOAD_TIMEOUT_MS` | `90s` / `30m` | Subprocess timeouts |
| `JOB_TTL_MS` / `FILE_TTL_MS` | `1h` | Retention before sweeping |
| `DATA_DIR` | `./data` | Work + completed files |
| `SERVE_FRONTEND` / `FRONTEND_DIR` | `true` / `../` | Serve the static frontend |
| `LOG_LEVEL` / `LOG_FILE` | `info` / — | Logging |

---

## Adding a new source

The extraction layer is pluggable. yt-dlp already supports ~1000 sites, so most hosts work via
the built-in generic handler once allowlisted. For per-site customisation, implement
`BaseSource` and register it:

```js
// src/sources/mysite.js
import { BaseSource } from "./base.js";

export class MySiteSource extends BaseSource {
  static id = "mysite";
  isSupported(hostname) {
    return hostname === "mysite.com" || hostname.endsWith(".mysite.com");
  }
  commonArgs() { return []; }       // e.g. ["--referer", "https://mysite.com/"]
  analyzeArgs() { return []; }      // yt-dlp flags for extraction
  downloadArgs() { return []; }     // yt-dlp flags for downloading
}

// src/sources/registry.js
import { MySiteSource } from "./mysite.js";
export const registry = new SourceRegistry([new GenericYtDlpSource(), new MySiteSource()]);
```

---

## Tests

```bash
npm test        # 22 unit + integration tests (no yt-dlp/ffmpeg required)
npm run e2e     # live, real end-to-end: analyze → download → merge → serve
                # (requires working yt-dlp + ffmpeg; optional E2E_URL override)
```

## Logging

Structured JSON lines to stdout (and `LOG_FILE` if set), covering request/response lifecycle,
yt-dlp subprocess activity, job state transitions and errors. Logs never contain user file
paths or secrets.