import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { removeDirSafe, listFiles } from "../lib/cleanup.js";
import { ApiError } from "../lib/urls.js";

/**
 * Tracks download jobs, serialises work through a concurrency-limited
 * queue, persists public state, and moves finished files into the
 * completed-files directory. Job ids / access tokens are random and
 * never derived from user input, so files can't be guessed.
 */
export function createJobManager({ config, downloader, logger, workDir, filesDir }) {
  const jobs = new Map(); // id -> job
  const queue = []; // job ids awaiting a worker slot
  let activeCount = 0;
  let seq = 0;

  function create({ url, formatId, format, title, expectedSizeBytes }) {
    if (jobs.size >= config.maxQueueLength) {
      throw new ApiError(429, "SERVER_BUSY", "The download queue is full. Please try again shortly.");
    }
    const id = randomUUID();
    const token = randomBytes(24).toString("hex");
    const job = {
      id,
      token,
      url,
      formatId,
      format: format || null,
      title: title || null,
      expectedSizeBytes: expectedSizeBytes || null,
      state: "queued",
      percent: 0,
      message: "Queued…",
      downloadUrl: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      workDir: null,
      finalPath: null,
      failCount: 0,
    };
    jobs.set(id, job);
    queue.push(id);
    logger.info("job enqueued", { jobId: id, formatId });
    pump();
    return job;
  }

  function pump() {
    while (activeCount < config.maxConcurrentDownloads && queue.length > 0) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job) continue;
      activeCount += 1;
      runJob(job);
    }
  }

  async function runJob(job) {
    const seqNo = ++seq;
    job.state = "processing";
    job.percent = 0;
    job.message = "Preparing…";
    job.workDir = path.join(workDir, job.id);
    fs.mkdirSync(job.workDir, { recursive: true });

    try {
      const finalPath = await downloader.download({
        url: job.url,
        formatId: job.formatId,
        format: job.format,
        workDir: job.workDir,
        timeoutMs: config.downloadTimeoutMs,
        logger,
        onProgress: ({ percent, message }) => {
          job.percent = Math.min(100, Math.max(0, percent));
          job.message = message || job.message;
        },
      });

      const staged = stageFile(finalPath, job.id, job.title);
      job.finalPath = staged.path;
      job.percent = 100;
      job.message = "Complete";
      job.state = "completed";
      job.completedAt = Date.now();
      job.downloadUrl = `/api/files/${job.id}/${job.token}`;
      logger.info("job completed", { jobId: job.id, seqNo, file: staged.name });
    } catch (err) {
      job.state = "failed";
      job.completedAt = Date.now();
      job.error = err instanceof ApiError ? err.publicMessage : "The download failed on the server.";
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError && err.code) job.errorCode = err.code;
      logger.warn("job failed", { jobId: job.id, seqNo, error: detail });
    } finally {
      removeDirSafe(job.workDir);
      job.workDir = null;
      activeCount -= 1;
      pump();
    }
  }

  function stageFile(src, jobId, title) {
    const ext = path.extname(src);
    const safeExt = ext && ext !== "." ? ext.slice(1) : "mp4";
    fs.mkdirSync(filesDir, { recursive: true });
    const tag = title ? sanitizeName(title) : "download";
    const name = `${jobId}-${tag}.${safeExt}`;
    const target = path.join(filesDir, name);
    fs.copyFileSync(src, target);
    return { path: target, name };
  }

  /** Clamp file leaf names to something safe for Content-Disposition. */
  function sanitizeName(raw) {
    if (!raw) return "download";
    return (
      raw
        .normalize("NFKD")
        .replace(/[^\w\s.\-()]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 120) || "download"
    );
  }

  function get(id) {
    return jobs.get(id) || null;
  }

  /** Public shape that the frontend polls. */
  function toPublic(job) {
    if (job.state === "queued") {
      return { jobId: job.id, status: "queued", percent: 0, message: "Queued…" };
    }
    const base = {
      jobId: job.id,
      status: job.state,
      percent: job.percent,
      message: job.message,
    };
    if (job.state === "completed") {
      base.downloadUrl = job.downloadUrl;
      base.fileName = job.finalPath ? sanitizeName(path.basename(job.finalPath)) : null;
    }
    if (job.state === "failed") {
      base.error = job.error || "The download failed.";
    }
    return base;
  }

  function snapshot() {
    return [...jobs.values()];
  }

  function remove(id) {
    const job = jobs.get(id);
    if (!job) return;
    if (job.finalPath && fs.existsSync(job.finalPath)) {
      try {
        fs.unlinkSync(job.finalPath);
      } catch {}
    }
    jobs.delete(id);
  }

  function pruneFilesOlderThan(ttlMs) {
    const now = Date.now();
    for (const f of listFiles(filesDir)) {
      const p = path.join(filesDir, f.name);
      try {
        const st = fs.statSync(p);
        const referenced = [...jobs.values()].some((j) => j.finalPath === p);
        if (st.mtimeMs < now - ttlMs && !referenced) fs.unlinkSync(p);
      } catch {}
    }
  }

  return { create, get, toPublic, snapshot, remove, pruneFilesOlderThan, workDir, filesDir };
}