import { Router } from "express";
import { guardUrl } from "../lib/urls.js";
import { validateFormatId } from "../middleware/security.js";

export function downloadRouter({ jobManager, analyzer, config, logger }) {
  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      const url = await guardUrl(req.body.url, config);
      const formatId = validateFormatId(req.body.formatId);

      // If we already analyzed this URL, make sure the chosen format is
      // actually one we offered, and enforce the per-stream size cap.
      const pending = analyzer.getCached(url.href);
      let cached = null;
      if (pending) {
        cached = pending.formats.find((f) => f.formatId === formatId) || null;
        if (!cached) {
          return res.status(422).json({
            error: {
              code: "INVALID_FORMAT",
              message: "The selected format is no longer available. Analyze the link again.",
            },
          });
        }
        if (config.maxFormatSizeBytes > 0 && cached.fileSizeBytes != null && cached.fileSizeBytes > config.maxFormatSizeBytes) {
          return res.status(422).json({
            error: {
              code: "FORMAT_TOO_LARGE",
              message: "That quality exceeds the server's file-size limit. Pick a smaller one.",
            },
          });
        }
      }

      const job = jobManager.create({
        url: url.href,
        formatId,
        format: cached,
        title: pending?.title,
        expectedSizeBytes: cached?.fileSizeBytes,
      });

      logger.info("download requested", { jobId: job.id, formatId, url: url.href });
      res.status(202).json({ jobId: job.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}