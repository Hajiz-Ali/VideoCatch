import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { ApiError } from "../lib/urls.js";
import { resolveYtdlp, resolveFfmpeg } from "../lib/binaries.js";

const PCT_RE = /(\d+(?:\.\d+)?)%/;

export function createDownloader({ config, registry, logger }) {
  /**
   * Download one format for a URL into workDir. `onProgress({percent,
   * message})` is called as yt-dlp reports progress. Resolves with the
   * path of the finished file, or rejects with an ApiError.
   */
  function download({ url, formatId, format, workDir, onProgress, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const binary = resolveYtdlp(config);
      if (!binary) {
        return onFailure(
          new ApiError(
            500,
            "BINARY_MISSING",
            "The media extractor (yt-dlp) is not installed on the server. Please ask the admin to install it."
          )
        );
      }

      // Multi-stream (video+audio) formats need ffmpeg to merge/remux.
      const needsMerge = String(formatId).split("+").filter((t) => t.trim().length > 1).length > 1;
      const ffmpegPath = resolveFfmpeg(config);
      if (needsMerge && !ffmpegPath) {
        return onFailure(
          new ApiError(
            422,
            "FFMPEG_MISSING",
            "This quality requires merging video and audio, but FFmpeg is not installed on the server. Please ask the admin to install it or pick a smaller quality."
          )
        );
      }

      const urlInstance = new URL(url);
      const handler = registry.findForHost(urlInstance.hostname);
      if (!handler) {
        return onFailure(new ApiError(422, "UNSUPPORTED_SITE", "This website is not supported."));
      }

      const outputTemplate = path.join(workDir, "output.%(ext)s");
      const args = [
        "--ignore-config",
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--progress",
        "--no-mtime",
        ...handler.commonArgs(),
        ...(config.cookiesFile ? ["--cookies", config.cookiesFile] : []),
        ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
        ...splitExtraArgs(config.ytDlpExtraArgs),
        ...handler.downloadArgs(),
        "-f",
        formatId,
        "-o",
        outputTemplate,
        ...(config.maxDownloadSizeBytes > 0
          ? ["--max-filesize", String(config.maxDownloadSizeBytes)]
          : []),
        url,
      ];

      const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let didTimeout = false;
      let stderr = "";

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            didTimeout = true;
            logger.warn("download timed out, killing process", { timeoutMs, url });
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

      // yt-dlp emits `[download]` progress to stdout when it's not a TTY
      // (and to stderr in other environments), so watch both streams.
      const onOutputLine = (line) => parseProgressLine(line, onProgress);
      const rlOut = readline.createInterface({ input: child.stdout });
      rlOut.on("line", onOutputLine);
      const rlErr = readline.createInterface({ input: child.stderr });
      rlErr.on("line", (line) => {
        stderr += line + "\n";
        parseProgressLine(line, onProgress);
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        if (err.code === "ENOENT") {
          onFailure(
            new ApiError(
              500,
              "BINARY_MISSING",
              "The media extractor (yt-dlp) is not installed on the server."
            )
          );
        } else {
          onFailure(new ApiError(500, "PROCESS_ERROR", "Could not launch the media extractor."));
        }
      });

      child.on("close", async (code) => {
        if (timer) clearTimeout(timer);
        if (didTimeout) {
          return onFailure(
            new ApiError(
              504,
              "TIMEOUT",
              "The download took too long and was cancelled by the server. Please retry with a lower quality."
            )
          );
        }
        if (code !== 0) {
          const msg = publicErrorFromStderr(stderr) || "The download failed on the server.";
          return onFailure(new ApiError(422, "DOWNLOAD_FAILED", msg));
        }
        let finalPath;
        try {
          finalPath = findFinishedFile(workDir);
        } catch (err) {
          logger.error("could not locate finished download", { err: err.message, url });
          return onFailure(
            new ApiError(500, "DOWNLOAD_FAILED", "The download finished but the file couldn't be located.")
          );
        }
        // Sources above ~1080p are frequently VP9/AV1, which many players
        // render as audio-only (or not at all). Convert those to a
        // universally playable H.264/AAC MP4 before delivering.
        if (format && format.video) {
          try {
            finalPath = await ensureMp4(finalPath, {
              ffmpegPath,
              workDir,
              format,
              onProgress,
              timeoutMs,
              logger,
            });
          } catch (err) {
            return onFailure(err);
          }
        }
        onProgress({ percent: 100, message: "Done" });
        resolve(finalPath);
      });

      function onFailure(err) {
        onProgress({ percent: 0, message: "Failed" });
        reject(err);
      }
    });
  }

  function parseProgressLine(line, onProgress) {
    if (line.startsWith("[download]")) {
      const m = line.match(PCT_RE);
      if (m) {
        const pct = Math.min(99, Number.parseFloat(m[1]));
        const message = pct >= 100 ? "Done" : "Downloading…";
        onProgress({ percent: pct, message });
      }
      return;
    }
    if (line.startsWith("[Merger]")) {
      onProgress({ percent: 99, message: "Merging video & audio…" });
      return;
    }
    if (line.startsWith("[ExtractAudio]") || line.startsWith("[Fixup")) {
      onProgress({ percent: 99, message: "Finalizing file…" });
    }
  }

  function findFinishedFile(workDir) {
    const entries = fs.readdirSync(workDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => path.join(workDir, e.name))
      .filter((p) => !/\.part$/i.test(p) && !/\.f\d+(\.\w+)?$/i.test(path.basename(p)) && !/\.ytdl$/i.test(p));
    if (files.length === 0) throw new Error("no completed file in work dir");
    // Prefer the largest non-temp file (the merged/muxed result).
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return files[0];
  }

  return { download };
}

function splitExtraArgs(str) {
  if (!str) return [];
  return str.split(/\s+/).filter(Boolean);
}

/** H.264/AVC is the only codec guaranteed to play in a plain .mp4. */
function isH264Codec(vcodec) {
  return !!vcodec && /^(avc1|h264|avc|mp4v)/i.test(vcodec);
}

/**
 * Make sure the finished file is a widely-playable MP4. H.264 streams are
 * simply repackaged (`-c copy`); anything else (VP9/AV1/HEVC) is re-encoded
 * to H.264/AAC, since those codecs are what make high-res downloads appear
 * "audio only" in many players.
 */
function ensureMp4(srcPath, { ffmpegPath, workDir, format, onProgress, timeoutMs, logger }) {
  const ext = path.extname(srcPath).toLowerCase();
  const alreadyH264 = isH264Codec(format.videoCodec);
  if (alreadyH264 && ext === ".mp4") return Promise.resolve(srcPath);
  if (!ffmpegPath) {
    throw new ApiError(
      422,
      "FFMPEG_MISSING",
      "Converting this download to MP4 requires FFmpeg, which is not installed on the server."
    );
  }

  const reencode = !alreadyH264;
  onProgress({ percent: 99, message: reencode ? "Converting to MP4…" : "Repackaging as MP4…" });

  const out = path.join(workDir, "converted.mp4");
  const args = reencode
    ? [
        "-y", "-hide_banner", "-loglevel", "error", "-i", srcPath,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ]
    : ["-y", "-hide_banner", "-loglevel", "error", "-i", srcPath, "-c", "copy", "-movflags", "+faststart", out];

  return runFfmpeg(ffmpegPath, args, timeoutMs, logger).then(() => out);
}

function runFfmpeg(binary, args, timeoutMs, logger) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            logger?.warn("ffmpeg conversion timed out, killing process");
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      reject(new ApiError(500, "PROCESS_ERROR", "Could not launch FFmpeg."));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        logger?.warn("ffmpeg conversion failed", { code, stderr: stderr.slice(0, 400) });
        return reject(
          new ApiError(500, "TRANSCODE_FAILED", "The video couldn't be converted to MP4 on the server.")
        );
      }
      resolve();
    });
  });
}

function publicErrorFromStderr(stderr) {
  const lines = stderr.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^ERROR:\s*(.*)$/);
    if (m) {
      const msg = m[1];
      const lower = msg.toLowerCase();
      if (lower.includes("transfer limit exceeded")) {
        return "That download exceeds the server's file-size limit.";
      }
      if (lower.includes("ffmpeg")) {
        return "This format needs FFmpeg, which is not installed on the server.";
      }
      if (lower.includes("unsupported url")) return "This website or link type is not supported.";
      return msg.length <= 240 ? msg : msg.slice(0, 240) + "…";
    }
  }
  return lines[lines.length - 1] || "";
}