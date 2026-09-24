import fs from "node:fs";
import path from "node:path";

export function removeDirSafe(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Best-effort; a sweeper will retry later.
    console.error(`cleanup: failed to remove ${dir}: ${err.message}`);
  }
}

export function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  } catch {
    return [];
  }
}

/**
 * Periodic sweeper: removes expired job records/work dirs and old
 * completed files. Returns a stop() function.
 */
export function startSweeper({ store, config, logger }) {
  function sweepOnce() {
    const now = Date.now();

    // Expired jobs → drop state and remove their (work or completed) dirs.
    for (const job of store.snapshot()) {
      const age = now - (job.completedAt || job.createdAt);
      if (job.state === "completed" || job.state === "failed") {
        if (age > config.jobTtlMs) {
          logger.info("sweeper: dropping expired job", { jobId: job.id, state: job.state });
          if (job.workDir) removeDirSafe(job.workDir);
          store.remove(job.id);
        }
      }
    }

    // Unreferenced files older than FILE_TTL in the completed-files dir.
    store.pruneFilesOlderThan(config.fileTtlMs);

    // Orphaned work dirs (crashed process) older than 24h.
    const orphanTtl = 24 * 60 * 60 * 1000;
    const wk = store.workDir;
    try {
      for (const entry of fs.readdirSync(wk, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = path.join(wk, entry.name);
        const stat = fs.statSync(p);
        if (now - stat.mtimeMs > orphanTtl && !store.snapshot().some((j) => j.workDir === p)) {
          logger.info("sweeper: removing orphaned work dir", { dir: entry.name });
          removeDirSafe(p);
        }
      }
    } catch {
      /* dir may not exist yet */
    }
  }

  // Clean anything left over from a previous run immediately.
  sweepOnce();

  const timer = setInterval(sweepOnce, config.cleanupIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}