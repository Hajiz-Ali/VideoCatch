import { spawn } from "node:child_process";
import readline from "node:readline";
import { ApiError } from "../lib/urls.js";

const PROGRESS_LINE = /\[download\]\s+(?:[\d.,]+%|\d)/;

/**
 * Run yt-dlp as a subprocess with an argv array (never a shell string) and
 * a hard timeout. Streams stderr/stdout line-by-line to `onLine`.
 */
export function runYtdlp({ binary, args, timeoutMs = 0, onLine, logger }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let didTimeout = false;

    const handleLine = (line) => {
      if (PROGRESS_LINE.test(line)) return; // parsed separately by callers
      try {
        onLine?.(line);
      } catch {
        /* observer errors never kill the pipeline */
      }
    };

    const rlOut = readline.createInterface({ input: child.stdout });
    const rlErr = readline.createInterface({ input: child.stderr });
    rlOut.on("line", (l) => {
      stdout += l + "\n";
      handleLine(l);
    });
    rlErr.on("line", (l) => {
      stderr += l + "\n";
      handleLine(l);
    });

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          didTimeout = true;
          logger?.warn("yt-dlp timed out, killing process", { timeoutMs, binary });
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new ApiError(
            500,
            "BINARY_MISSING",
            "The media extractor (yt-dlp) is not installed on the server. See the admin before retrying."
          )
        );
      } else {
        reject(new ApiError(500, "PROCESS_ERROR", "Could not launch the media extractor."));
      }
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (didTimeout) {
        reject(
          new ApiError(
            504,
            "TIMEOUT",
            "The operation took too long and was cancelled by the server. Please retry."
          )
        );
        return;
      }
      if (code !== 0) {
        const errLine = lastErrorLine(stderr) || lastErrorLine(stdout);
        const publicMsg = publicErrorFromYtdlp(errLine) || "The extractor failed to process this media.";
        logger?.warn("yt-dlp exited non-zero", { code, errLine });
        reject(new ApiError(422, "EXTRACTION_FAILED", publicMsg));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function lastErrorLine(stream) {
  const lines = stream.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^ERROR:\s*(.*)$/);
    if (m) return m[1];
  }
  return lines[lines.length - 1] || "";
}

function publicErrorFromYtdlp(errLine) {
  if (!errLine) return null;
  const lower = errLine.toLowerCase();
  if (lower.includes("unsupported url")) {
    return "This website or link type is not supported.";
  }
  if (
    lower.includes("video unavailable") ||
    lower.includes("has been removed") ||
    lower.includes("not available") ||
    lower.includes("404")
  ) {
    return "The video is unavailable or has been removed.";
  }
  if (
    lower.includes("private") ||
    lower.includes("members only") ||
    lower.includes("sign in")
  ) {
    return "This content is private or requires authentication. If you have access, ask the admin to configure authorized cookies.";
  }
  if (
    lower.includes("age") ||
    lower.includes("not available in your country") ||
    lower.includes("geo")
  ) {
    return "This content is age-restricted or not available in your region.";
  }
  if (lower.includes("copies require a ffmpeg")) {
    return "This format needs FFmpeg, which is not installed on the server.";
  }
  if (lower.includes("transfer limit exceeded")) {
    return "That download exceeds the server's file-size limit.";
  }
  if (lower.includes("drm")) {
    return "This content is DRM-protected and cannot be downloaded.";
  }
  if (lower.includes("live")) {
    return "This appears to be a live stream and cannot be downloaded as a file.";
  }
  return errLine.length <= 240 ? errLine : errLine.slice(0, 240) + "…";
}