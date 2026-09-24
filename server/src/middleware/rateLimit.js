/* Simple fixed-window, per-key (IP) rate limiter. Kept in-memory:
 * restarting the server resets the counters, which is acceptable for
 * a single-instance deployment. */

export function createRateLimiter({ points, windowMs, keyFrom = (req) => req.ip, logger }) {
  const buckets = new Map();

  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, b] of buckets) {
      if (b.resetAt <= cutoff) buckets.delete(key);
    }
  }, Math.max(windowMs / 4, 1000));
  timer.unref?.();

  function limit(req, res, next) {
    if (!points || points <= 0) return next();
    const key = keyFrom(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    res.set("X-RateLimit-Limit", String(points));
    res.set("X-RateLimit-Remaining", String(Math.max(0, points - b.count)));
    if (b.count > points) {
      const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      logger?.warn("rate limit exceeded", { key, retryAfter });
      return res.status(429).json({
        error: { code: "RATE_LIMITED", message: `Too many requests. Please retry in ${retryAfter}s.` },
      });
    }
    return next();
  }
  return limit;
}

export function clientIpFrom(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "unknown";
}