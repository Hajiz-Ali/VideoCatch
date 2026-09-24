import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { resolveYtdlp } from "../src/lib/binaries.js";
import { loadConfig } from "../src/config.js";

let app, server, base, stopSweeper;

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "udl-test-"));
  const overrides = {
    DATA_DIR: path.join(tmp, "data"),
    SERVE_FRONTEND: "false",
    LOG_LEVEL: "error",
    ANALYZE_RATE_LIMIT: "1000",
    DOWNLOAD_RATE_LIMIT: "1000",
    POD_PROGRESS_RATE_LIMIT: "1000",
    // Force binary resolution to fail so tests are deterministic.
    YT_DLP_BINARY: "yt-dlp-does-not-exist-xyz",
    FFMPEG_BINARY: "ffmpeg-does-not-exist-xyz",
  };
  ({ app, stopSweeper } = createApp(overrides));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  stopSweeper?.();
});

function post(p, body) {
  return fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /health reports ok and binary status", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.extractor.ytDlp, false);
});

test("analyze rejects missing body", async () => {
  const res = await post("/v1/analyze", {});
  assert.equal(res.status, 400);
});

test("analyze rejects bad URL shapes", async () => {
  for (const payload of [{ url: "not a url" }, { url: "ftp://x.com/a" }, { url: "" }]) {
    const res = await post("/v1/analyze", payload);
    assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`);
  }
});

test("analyze blocks private / SSRF targets", async () => {
  const res = await post("/v1/analyze", { url: "http://127.0.0.1:8080/secret" });
  assert.ok(res.status === 400 || res.status === 422, `got ${res.status}`);
  const json = await res.json();
  assert.match(json.error.code, /SSRF_BLOCKED|DNS_FAILED/);
});

test("analyze returns BINARY_MISSING when extractor absent", async () => {
  const res = await post("/v1/analyze", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.error.code, "BINARY_MISSING");
});

test("v1 and api aliases route identically", async () => {
  const [a, b] = await Promise.all([
    post("/v1/analyze", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    post("/api/analyze", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
  ]);
  assert.equal(a.status, 500);
  assert.equal(b.status, 500);
});

test("download validates format id", async () => {
  const res = await post("/v1/download", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", formatId: "bad; rm -rf" });
  assert.equal(res.status, 400);
});

test("download rejects missing format id", async () => {
  const res = await post("/v1/download", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(res.status, 400);
});

test("unknown job returns 404", async () => {
  const res = await fetch(base + "/v1/progress/00000000-0000-0000-0000-000000000000");
  assert.equal(res.status, 404);
});

test("invalid job id returns 404", async () => {
  const res = await fetch(base + "/v1/progress/../etc/passwd");
  assert.equal(res.status, 404);
});

test("config parses required ints and rejects bad ones", () => {
  assert.throws(() => loadConfig({ PORT: "abc" }));
  assert.throws(() => loadConfig({ PORT: "-1" }));
  const cfg = loadConfig({ PORT: "9999", MAX_CONCURRENT_DOWNLOADS: "3" });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.maxConcurrentDownloads, 3);
  assert.ok(typeof cfg.allowedDomains === "object");
});