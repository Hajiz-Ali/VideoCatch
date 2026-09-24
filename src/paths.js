import path from "node:path";
import fs from "node:fs";
import { SERVER_ROOT } from "./config.js";

export function initPaths(dataDir) {
  const root = path.resolve(SERVER_ROOT, dataDir);
  const workDir = path.join(root, "work");
  const filesDir = path.join(root, "files");
  for (const dir of [root, workDir, filesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { dataRoot: root, workDir, filesDir };
}