import { ApiError } from "../lib/urls.js";

const FORMAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9+_.\-]*$/;

/** Reject bodies that aren't a plain JSON object with one string field. */
export function requireBodyFields(names) {
  return function validate(req, _res, next) {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return next(new ApiError(400, "BAD_REQUEST", "Request body must be a JSON object."));
    }
    for (const name of names) {
      const v = body[name];
      if (typeof v !== "string" || v.trim() === "") {
        return next(
          new ApiError(400, "BAD_REQUEST", `Missing or invalid "${name}" field in the request body.`)
        );
      }
    }
    return next();
  };
}

/** Validate that a format/quality identifier is syntactically safe. */
export function validateFormatId(formatId) {
  if (typeof formatId !== "string" || !FORMAT_ID_RE.test(formatId) || formatId.length > 200) {
    throw new ApiError(
      400,
      "INVALID_FORMAT",
      "The selected format is invalid or no longer available."
    );
  }
  return formatId;
}

/** A compact set of safety headers for the API and static frontend. */
export function securityHeaders(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  next();
}