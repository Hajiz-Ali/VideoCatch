import { buildFormatOptions, extractVideoInfo } from "../lib/formats.js";
import { runYtdlp } from "./ytdlp.js";
import { ApiError } from "../lib/urls.js";
import { resolveYtdlp } from "../lib/binaries.js";

/** Analyzes a URL with yt-dlp and returns *real* detected data. */
export function createAnalyzer({ config, registry, logger }) {
  const cache = new Map();

  async function analyzeUrl(rawUrl) {
    const key = `${rawUrl}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < config.analyzeCacheTtlMs) {
      logger.info("analyze: cache hit", { key });
      return hit.data;
    }

    const binary = resolveYtdlp(config);
    if (!binary) {
      throw new ApiError(
        500,
        "BINARY_MISSING",
        "The media extractor (yt-dlp) is not installed on the server. Please ask the admin to install it."
      );
    }

    const url = new URL(rawUrl);
    const handler = registry.findForHost(url.hostname);
    if (!handler) {
      throw new ApiError(422, "UNSUPPORTED_SITE", "This website is not supported.");
    }

    // Build a real argv — no shell, no user-controlled flags.
    const fullArgs = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      "--dump-json",
      "-o",
      "NA",
      ...handler.commonArgs(),
      ...(config.cookiesFile ? ["--cookies", config.cookiesFile] : []),
      ...splitExtraArgs(config.ytDlpExtraArgs),
      ...handler.analyzeArgs(),
      rawUrl,
    ];

    logger.info("analyze: extracting", { url: rawUrl });
    let result;
    try {
      result = await runYtdlp({
        binary,
        args: fullArgs,
        timeoutMs: config.analyzeTimeoutMs,
        logger,
      });
    } catch (err) {
      throw toApiError(err, "Couldn't analyze this link.");
    }

    let info;
    try {
      info = JSON.parse(result.stdout);
    } catch {
      throw new ApiError(
        422,
        "EXTRACTION_FAILED",
        "The site returned data we couldn't parse. It may have changed recently."
      );
    }

    const base = extractVideoInfo(info);
    const { formats, bestFormatId } = buildFormatOptions(info, config.maxFormatSizeBytes);

    if (formats.length === 0) {
      throw new ApiError(
        422,
        "NO_FORMATS",
        "This link didn't return any downloadable media. It may be a playlist, a live stream, or protected content."
      );
    }

    const data = {
      url: rawUrl,
      title: base.title || "Untitled video",
      source: base.source,
      thumbnailUrl: base.thumbnailUrl,
      durationSeconds: base.durationSeconds,
      formats,
      bestFormatId,
    };

    cache.set(key, { at: Date.now(), data });
    if (cache.size > 200) cache.delete(cache.keys().next().value);

    return data;
  }

  /** Look up a previously analyzed format (used by /download). */
  function findCachedFormat(rawUrl, formatId) {
    const hit = cache.get(`${rawUrl}`);
    if (!hit || Date.now() - hit.at >= config.analyzeCacheTtlMs) return null;
    return hit.data.formats.find((f) => f.formatId === formatId) || null;
  }

  /** Full previously analyzed payload, or null if expired/missing. */
  function getCached(rawUrl) {
    const hit = cache.get(`${rawUrl}`);
    if (!hit || Date.now() - hit.at >= config.analyzeCacheTtlMs) return null;
    return hit.data;
  }

  return { analyzeUrl, findCachedFormat, getCached };
}

function splitExtraArgs(str) {
  if (!str) return [];
  return str.split(/\s+/).filter(Boolean);
}

function toApiError(err, fallback) {
  if (err instanceof ApiError) return err;
  return new ApiError(500, "INTERNAL", fallback);
}