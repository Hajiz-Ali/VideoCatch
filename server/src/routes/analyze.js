import { Router } from "express";
import { guardUrl } from "../lib/urls.js";

export function analyzeRouter({ analyzer, config }) {
  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      const url = await guardUrl(req.body.url, config);
      const data = await analyzer.analyzeUrl(url.href);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}