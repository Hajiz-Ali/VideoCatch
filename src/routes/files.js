import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { ApiError } from "../lib/urls.js";

/**
 * Serves completed downloads. The two-segment tokenised URL means users
 * can only fetch files they possess the link for — job ids and tokens are
 * random and are never guessable. Path is resolved inside the files dir
 * and cross-checked against the stored job before streaming.
 */
export function filesRouter({ jobManager, config, logger }) {
  const router = Router();
  const filesRoot = path.resolve(jobManager.filesDir);

  router.get("/:jobId/:token", (req, res, next) => {
    try {
      const { jobId, token } = req.params;
      if (typeof token !== "string" || !/^[0-9a-f]{48}$/i.test(token)) {
        throw new ApiError(403, "FORBIDDEN", "Invalid access token.");
      }
      const job = jobManager.get(jobId);
      if (!job || job.token !== token) {
        throw new ApiError(403, "FORBIDDEN", "This download link is invalid or expired.");
      }
      if (job.state !== "completed" || !job.finalPath) {
        throw new ApiError(409, "NOT_READY", "This download is not finished yet.");
      }

      const resolved = path.resolve(job.finalPath);
      const within = resolved.startsWith(filesRoot + path.sep);
      if (!within || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new ApiError(404, "NOT_FOUND", "The file is no longer available.");
      }

      return res.sendFile(resolved, {
        headers: {
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
        },
        acceptRanges: true,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}