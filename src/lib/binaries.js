import { spawnSync } from "node:child_process";
import fs from "node:fs";

/* Locate the yt-dlp / ffmpeg executables (respecting env overrides,
 * then PATH, then common Windows names). Results are cached. */

const cache = new Map();

function tryVersion(candidate, args) {
  const res = spawnSync(candidate, args, { stdio: "ignore", timeout: 10000 });
  return !res.error && res.status === 0;
}

function find(candidates, args, id) {
  if (cache.has(id)) return cache.get(id);
  for (const c of candidates) {
    if (c && tryVersion(c, args)) {
      cache.set(id, c);
      return c;
    }
  }
  cache.set(id, null);
  return null;
}

export function resolveYtdlp(config) {
  const envOverride = config.ytDlpBinary;
  return find([envOverride, "yt-dlp", "yt-dlp.exe"].filter(Boolean), ["--version"], "yt-dlp");
}

export function resolveFfmpeg(config) {
  const envOverride = config.ffmpegBinary;
  return find([envOverride, "ffmpeg", "ffmpeg.exe"].filter(Boolean), ["-version"], "ffmpeg");
}

export function hasFfmpeg(config) {
  return resolveFfmpeg(config) != null;
}

export function clearBinaryCache() {
  cache.clear();
}