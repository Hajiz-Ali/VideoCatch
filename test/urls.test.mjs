import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateAddress,
  hostMatchesAllowlist,
  parseAndValidateUrl,
  ApiError,
} from "../src/lib/urls.js";

test("private/reserved addresses are detected", () => {
  const privates = [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.2.10",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "240.1.2.3",
    "::1",
    "::",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:192.168.1.1",
    "::ffff:127.0.0.1",
    "ff02::1",
  ];
  for (const ip of privates) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test("public addresses are allowed", () => {
  const publics = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of publics) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("host matching handles subdomains and trailing dots", () => {
  const list = ["youtube.com", "tiktok.com"];
  assert.equal(hostMatchesAllowlist("youtube.com", list), true);
  assert.equal(hostMatchesAllowlist("www.youtube.com", list), true);
  assert.equal(hostMatchesAllowlist("YouTube.com.", list), true);
  assert.equal(hostMatchesAllowlist("youtube.com.evil.net", list), false);
  assert.equal(hostMatchesAllowlist("fakeyoutube.com", list), false);
  assert.equal(hostMatchesAllowlist("tiktok.com", ["tiktok.com"]), true);
  assert.equal(hostMatchesAllowlist("8.8.8.8", list), false);
});

test("URL validation rejects junk input", () => {
  const max = 2048;
  for (const bad of ["", "   ", "not-a-url", "ftp://x.com/v", "javascript:alert(1)", "http://x.co m/v"]) {
    assert.throws(() => parseAndValidateUrl(bad, max), ApiError, `should reject "${bad}"`);
  }
  assert.throws(() => parseAndValidateUrl("https://x.com/" + "a".repeat(3000), max), ApiError);
  // Schemeless / dotless hosts like "http:/nohost" normalise to hostname
  // "nohost" — syntactically valid, but the allowlist rejects them later.
  assert.equal(parseAndValidateUrl("http:/nohost", max).hostname, "nohost");
});

test("valid http(s) URLs pass validation", () => {
  const u = parseAndValidateUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 2048);
  assert.equal(u.hostname, "www.youtube.com");
  const u2 = parseAndValidateUrl("http://example.com/video.webm", 2048);
  assert.equal(u2.protocol, "http:");
});