import express from "express";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { initPaths } from "./paths.js";
import { registry } from "./sources/registry.js";
import { createAnalyzer } from "./services/analyzer.js";
import { createDownloader } from "./services/downloader.js";
import { createJobManager } from "./services/jobManager.js";
import { startSweeper } from "./lib/cleanup.js";
import { resolveYtdlp, resolveFfmpeg } from "./lib/binaries.js";

import { createRateLimiter, clientIpFrom } from "./middleware/rateLimit.js";
import { requireBodyFields, securityHeaders } from "./middleware/security.js";
import { notFoundHandler, errorHandler } from "./middleware/errors.js";

import { analyzeRouter } from "./routes/analyze.js";
import { downloadRouter } from "./routes/download.js";
import { progressRouter } from "./routes/progress.js";
import { filesRouter } from "./routes/files.js";

export function createApp(envOverrides = {}) {
  const config = loadConfig(envOverrides);
  const logger = createLogger({ level: config.logLevel, file: config.logFile });
  const paths = initPaths(config.dataDir);

  // Pre-flight binary availability (reported in /health and logs).
  const ytDlp = resolveYtdlp(config);
  const ffmpeg = resolveFfmpeg(config);
  logger.info(
    ytDlp
      ? `yt-dlp available at ${ytDlp}`
      : "WARNING: yt-dlp not found — analysis and downloads will fail until it is installed.",
    {}
  );
  logger.info(ffmpeg ? "ffmpeg available" : "WARNING: ffmpeg not found — multi-stream merging will fail.", {});

  const analyzer = createAnalyzer({ config, registry, logger });
  const downloader = createDownloader({ config, registry, logger });
  const jobManager = createJobManager({ config, downloader, logger, ...paths });

  const app = express();
  app.disable("x-powered-by");
  app.locals.config = config;
  app.locals.logger = logger;

  const ipKey = (req) => clientIpFrom(req);

  const limiter = {
    analyze: createRateLimiter({ points: config.analyzeRateLimit, windowMs: 60_000, keyFrom: ipKey, logger }),
    download: createRateLimiter({ points: config.downloadRateLimit, windowMs: 60_000, keyFrom: ipKey, logger }),
    progress: createRateLimiter({ points: config.progressRateLimit, windowMs: 60_000, keyFrom: ipKey, logger }),
  };

  const jsonBody = express.json({ limit: "16kb" });
  app.use(securityHeaders);
  app.use("/", (req, res, next) => {
    logger.debug("request", { method: req.method, url: req.originalUrl, ip: clientIpFrom(req) });
    next();
  });

  // Health (no auth, no rate limit — minimal and static).
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      extractor: { ytDlp: !!ytDlp, ffmpeg: !!ffmpeg },
      downloadsActive: jobManager.snapshot().filter((j) => j.state === "processing").length,
    });
  });

  // API — mounted both under /api (documented) and /v1 (frontend contract).
  const apiMounts = ["/api", "/v1"];
  const analyzeRoutes = [jsonBody, requireBodyFields(["url"]), limiter.analyze, analyzeRouter({ analyzer, config })];
  const downloadRoutes = [
    jsonBody,
    requireBodyFields(["url", "formatId"]),
    limiter.download,
    downloadRouter({ jobManager, analyzer, config, logger }),
  ];

  for (const mount of apiMounts) {
    app.use(`${mount}/analyze`, analyzeRoutes);
    app.use(`${mount}/download`, downloadRoutes);
    app.use(`${mount}/progress`, limiter.progress, progressRouter({ jobManager }));
  }
  app.use("/api/files", filesRouter({ jobManager, config, logger }));

  // Static frontend (optional).
  if (config.serveFrontend) {
    const frontendDir = path.resolve(config.frontendDir);
    if (fs.existsSync(frontendDir)) {
      app.use(
        express.static(frontendDir, {
          index: "index.html",
          dotfiles: "deny",
          etag: true,
          maxAge: "0",
          setHeaders(res) {
            res.setHeader("X-Content-Type-Options", "nosniff");
          },
        })
      );
    } else {
      logger.warn("FRONTEND_DIR does not exist; skipping static hosting", { frontendDir });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  const stopSweeper = startSweeper({ store: jobManager, config, logger });

  return { app, config, logger, jobManager, stopSweeper };
}

export function startServer() {
  const { app, config, logger, stopSweeper } = createApp();

  const server = app.listen(config.port, config.host, () => {
    logger.info(`Universal Downloader server listening on http://${config.host}:${config.port}`);
    logger.info(
      config.serveFrontend
        ? `Frontend served from ${path.resolve(config.frontendDir)}`
        : "Static frontend hosting disabled",
      {}
    );
  });

  server.on("error", (err) => {
    logger.error("server failed to start", { message: err.message });
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    logger.warn(`${signal} received — shutting down`);
    stopSweeper();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}