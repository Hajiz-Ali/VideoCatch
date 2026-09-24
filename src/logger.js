import { createWriteStream } from "node:fs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info", file } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const stream = file ? createWriteStream(file, { flags: "a" }) : null;

  function emit(lvl, msg, fields) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: lvl,
      msg,
      ...(fields || {}),
    });
    if (stream) stream.write(line + "\n");
    process.stdout.write(line + "\n");
  }

  return {
    debug: (msg, f) => LEVELS.debug >= threshold && emit("debug", msg, f),
    info: (msg, f) => LEVELS.info >= threshold && emit("info", msg, f),
    warn: (msg, f) => LEVELS.warn >= threshold && emit("warn", msg, f),
    error: (msg, f) => LEVELS.error >= threshold && emit("error", msg, f),
    close() {
      if (stream) stream.end();
    },
  };
}