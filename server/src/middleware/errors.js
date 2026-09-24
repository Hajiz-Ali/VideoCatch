import { ApiError } from "../lib/urls.js";

/** 404 for unknown API routes. */
export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } });
}

/** Central error handler: never leaks internals or filesystem paths. */
export function errorHandler(logger) {
  return function (err, _req, res, _next) {
    if (err instanceof ApiError) {
      if (err.status >= 500) logger?.warn("api error", { status: err.status, code: err.code });
      return res.status(err.status).json({
        error: { code: err.code || "ERROR", message: err.publicMessage || "Request failed." },
      });
    }

    if (err && err.type === "entity.parse.failed") {
      return res
        .status(400)
        .json({ error: { code: "BAD_JSON", message: "Request body is not valid JSON." } });
    }

    if (err && err.type === "entity.too.large") {
      return res
        .status(413)
        .json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
    }

    logger?.error("unhandled error", { message: err?.message, stack: err?.stack });
    return res.status(500).json({
      error: { code: "INTERNAL", message: "An unexpected error occurred. Please try again." },
    });
  };
}