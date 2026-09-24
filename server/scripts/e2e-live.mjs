/* Live end-to-end check: boots the real server, analyzes a real public
 * video, downloads it, and verifies the served file. Requires node,
 * yt-dlp and ffmpeg to be configured (see server/.env). Run:
 *   npm run e2e
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";

const TEST_URL = process.env.E2E_URL || "https://www.youtube.com/watch?v=jNQXAC9IVRw";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { app, stopSweeper } = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n=== E2E against ${TEST_URL}\n`);

  try {
    // 1. Analyze
    const analRes = await fetch(`${base}/v1/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: TEST_URL }),
    });
    const analyzed = await analRes.json();
    if (!analRes.ok) {
      console.error("ANALYZE FAILED:", JSON.stringify(analyzed, null, 2));
      process.exit(1);
    }
    console.log("title:", analyzed.title);
    console.log("source:", analyzed.source, "| duration:", analyzed.durationSeconds);
    console.log("bestFormatId:", analyzed.bestFormatId);
    console.log("formats:");
    for (const f of analyzed.formats) {
      console.log(
        `  - ${f.quality.padEnd(9)} ${f.container.padEnd(5)} size=${f.fileSizeBytes ?? "?"} fmt=${f.formatId}`
      );
    }
    if (!analyzed.formats.length) throw new Error("no formats returned");

    // 2. Download (use Best Quality — the value the frontend defaults to)
    const dlRes = await fetch(`${base}/v1/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: TEST_URL, formatId: analyzed.bestFormatId }),
    });
    const dl = await dlRes.json();
    if (!dlRes.ok) {
      console.error("DOWNLOAD FAILED:", JSON.stringify(dl, null, 2));
      process.exit(1);
    }
    console.log("\njobId:", dl.jobId);

    // 3. Poll progress
    let lastStatus = "";
    for (let i = 0; i < 240; i++) {
      await sleep(1000);
      const p = await (await fetch(`${base}/v1/progress/${dl.jobId}`)).json();
      if (p.status !== lastStatus || i % 5 === 0) {
        console.log(`  [${p.status}] ${p.percent}% ${p.message}`);
        lastStatus = p.status;
      }
      if (p.status === "completed") {
        console.log("FILE:", p.fileName, "\nURL:", p.downloadUrl);
        // 4. Fetch the finished file and verify it isn't empty.
        const fileRes = await fetch(base + p.downloadUrl);
        const bytes = Buffer.concat([Buffer.from(await fileRes.arrayBuffer())]);
        console.log(`downloaded ${bytes.length} bytes, status ${fileRes.status}`);
        if (!fileRes.ok || bytes.length === 0) throw new Error("file fetch failed");
        if (p.fileName) {
          const out = path.join(process.cwd(), "data", "files", p.fileName);
          if (fs.existsSync(out)) fs.unlinkSync(out); // keep dirs clean
        }
        return;
      }
      if (p.status === "failed") {
        console.error("DOWNLOAD FAILED:", p.error);
        process.exit(1);
      }
    }
    throw new Error("timed out waiting for download");
  } finally {
    server.closeAllConnections?.();
    server.close();
    stopSweeper();
  }
}

main().then(
  () => console.log("\nE2E OK"),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);