import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, "..");

const DEFAULT_ALLOWED_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "fb.watch",
  "vimeo.com",
  "dailymotion.com",
  "reddit.com",
  "redd.it",
  "twitch.tv",
  "soundcloud.com",
  "bandcamp.com",
  "rumble.com",
  "odysee.com",
  "streamable.com",
  "vidyard.com",
  "wistia.com",
  "brightcove.com",
];

function intEnv(src, name, fallback) {
  const raw = src[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

function strEnv(src, name, fallback) {
  const raw = src[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.trim();
}

function boolEnv(src, name, fallback) {
  const raw = src[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function listEnv(src, name, fallback) {
  const raw = src[name];
  if (raw === undefined || raw === "") return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };

  const cfg = {
    port: intEnv(env, "PORT", 8787),
    host: strEnv(env, "HOST", "0.0.0.0"),

    ytDlpBinary: strEnv(env, "YT_DLP_BINARY", ""),
    ffmpegBinary: strEnv(env, "FFMPEG_BINARY", ""),
    cookiesFile: strEnv(env, "YT_DLP_COOKIES_FILE", ""),
    ytDlpExtraArgs: strEnv(env, "YT_DLP_EXTRA_ARGS", ""),

    allowedDomains: listEnv(env, "ALLOWED_DOMAINS", DEFAULT_ALLOWED_DOMAINS),
    allowAllHosts: boolEnv(env, "ALLOW_ALL_HOSTS", false),

    maxConcurrentDownloads: intEnv(env, "MAX_CONCURRENT_DOWNLOADS", 2),
    maxConcurrentAnalyzes: intEnv(env, "MAX_CONCURRENT_ANALYZES", 3),
    maxQueueLength: intEnv(env, "MAX_QUEUE_LENGTH", 100),
    maxUrlLength: intEnv(env, "MAX_URL_LENGTH", 2048),

    analyzeRateLimit: intEnv(env, "ANALYZE_RATE_LIMIT", 20),
    downloadRateLimit: intEnv(env, "DOWNLOAD_RATE_LIMIT", 10),
    progressRateLimit: intEnv(env, "POD_PROGRESS_RATE_LIMIT", 60),

    maxFormatSizeBytes: intEnv(env, "MAX_FORMAT_SIZE_BYTES", 4 * 1024 ** 3),
    maxDownloadSizeBytes: intEnv(env, "MAX_DOWNLOAD_SIZE_BYTES", 0),

    analyzeTimeoutMs: intEnv(env, "ANALYZE_TIMEOUT_MS", 90000),
    downloadTimeoutMs: intEnv(env, "DOWNLOAD_TIMEOUT_MS", 30 * 60 * 1000),
    jobTtlMs: intEnv(env, "JOB_TTL_MS", 60 * 60 * 1000),
    fileTtlMs: intEnv(env, "FILE_TTL_MS", 60 * 60 * 1000),
    cleanupIntervalMs: intEnv(env, "CLEANUP_INTERVAL_MS", 5 * 60 * 1000),
    analyzeCacheTtlMs: intEnv(env, "ANALYZE_CACHE_TTL_MS", 30 * 60 * 1000),

    dataDir: strEnv(env, "DATA_DIR", "data"),
    serveFrontend: boolEnv(env, "SERVE_FRONTEND", true),
    frontendDir: strEnv(env, "FRONTEND_DIR", SERVER_ROOT),

    logLevel: strEnv(env, "LOG_LEVEL", "info"),
    logFile: strEnv(env, "LOG_FILE", ""),
  };

  if (cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`PORT must be between 1 and 65535, got ${cfg.port}`);
  }
  if (!cfg.ytDlpBinary && process.platform === "win32") {
    cfg.ytDlpBinary = "yt-dlp.exe";
  }
  if (!cfg.ffmpegBinary && process.platform === "win32") {
    cfg.ffmpegBinary = "ffmpeg.exe";
  }

  return cfg;
}