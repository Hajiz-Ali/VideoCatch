import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class ApiError extends Error {
  constructor(status, code, publicMessage, details) {
    super(publicMessage);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = details;
  }
}

/* ------------------------------------------------------------------
 * IPv4 / IPv6 private + reserved nets. Used to block SSRF targets.
 * NOTE: this deliberately errs on the side of caution and includes
 * documentation/reserved ranges commonly used in SSRF & DNS-rebinding
 * attacks (metadata endpoint, link-local, CGNET, etc.).
 * ------------------------------------------------------------------ */
function isPrivateV4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // link-local /169.254/16 (incl. metadata 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 0) || // 192.0.0.0/24 (incl. 192.0.0.9)
    (a === 192 && b === 168) || // 192.168/16
    (a === 192 && b === 0 && parts[2] === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && parts[2] === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && parts[2] === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 // multicast + reserved
  );
}

function isPrivateV6(ip) {
  const addr = ip.toLowerCase();
  const isMapped = addr.startsWith("::ffff:");
  if (isMapped) {
    // IPv4-mapped IPv6 like ::ffff:127.0.0.1 — check the embedded v4.
    const v4 = addr.slice(7);
    return isIP(v4) === 4 && isPrivateV4(v4);
  }
  if (addr === "::" || addr === "::1") return true;
  // Unique local fc00::/7  (fc00…fdff)
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  // Documentation 2001:db8::/32
  if (addr.startsWith("2001:db8:")) return true;
  // Multicast ff00::/8
  if (addr.startsWith("ff")) return true;
  // Discard-only 100::/64
  if (addr.startsWith("100::")) return true;
  return false;
}

export function isPrivateAddress(address) {
  const ip = String(address).toLowerCase();
  const stripped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const kind = isIP(stripped);
  if (kind === 4) return isPrivateV4(stripped);
  if (kind === 6) return isPrivateV6(stripped);
  return false;
}

export function parseAndValidateUrl(input, maxLength) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ApiError(400, "INVALID_URL", "A URL is required.");
  }
  const raw = input.trim();
  if (raw.length > (maxLength || 2048)) {
    throw new ApiError(400, "URL_TOO_LONG", "The URL is too long.");
  }
  // Reject control chars / whitespace inside the URL outright.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) {
    throw new ApiError(400, "INVALID_URL", "The URL contains invalid characters.");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "INVALID_URL", "That doesn't look like a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, "INVALID_URL", "Only http:// and https:// URLs are supported.");
  }
  if (!url.hostname) {
    throw new ApiError(400, "INVALID_URL", "The URL is missing a hostname.");
  }

  return url;
}

export function hostMatchesAllowlist(hostname, allowedDomains) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  if (isIP(host)) return false;
  return allowedDomains.some((domain) => {
    const d = String(domain).toLowerCase().replace(/\.$/, "");
    return host === d || host.endsWith("." + d);
  });
}

/**
 * Resolve the host and reject the request if any resolved address is
 * private/reserved. This is the core SSRF guard. DNS rebinding is still
 * possible after this check for hostile domains, which is why an
 * explicit domain allowlist is enforced too (see guardUrl).
 */
export async function assertPublicTarget(url) {
  let records;
  try {
    records = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new ApiError(422, "DNS_FAILED", "Could not resolve that site's address.");
  }
  if (!records || records.length === 0) {
    throw new ApiError(422, "DNS_FAILED", "The site has no resolvable address.");
  }
  const bad = records.filter((r) => isPrivateAddress(r.address));
  if (bad.length > 0) {
    throw new ApiError(
      400,
      "SSRF_BLOCKED",
      "This URL points to a local/internal network address and is not allowed."
    );
  }
}

/**
 * Full guard used by every endpoint that accepts a user URL: shape
 * validation + SSRF DNS check + domain allowlist. Returns the URL as
 * a parsed URL object.
 */
export async function guardUrl(rawUrl, config) {
  const url = parseAndValidateUrl(rawUrl, config.maxUrlLength);
  await assertPublicTarget(url);
  if (!config.allowAllHosts && !hostMatchesAllowlist(url.hostname, config.allowedDomains)) {
    throw new ApiError(
      422,
      "UNSUPPORTED_SITE",
      "This website is not currently supported. Supported sources are configured by the server administrator."
    );
  }
  return url;
}