import { Router } from "express";
import { ApiError } from "../lib/urls.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function progressRouter({ jobManager }) {
  const router = Router();

  router.get("/:jobId", (req, res, next) => {
    try {
      const { jobId } = req.params;
      if (!UUID_RE.test(jobId)) {
        throw new ApiError(404, "NOT_FOUND", "Unknown download job.");
      }
      const job = jobManager.get(jobId);
      if (!job) throw new ApiError(404, "NOT_FOUND", "Unknown download job.");
      res.json(jobManager.toPublic(job));
    } catch (err) {
      next(err);
    }
  });

  return router;
}