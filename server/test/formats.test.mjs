import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFormatOptions, extractVideoInfo, qualityLabel } from "../src/lib/formats.js";

// A realistic yt-dlp --dump-json subset for a 720p MP4 + 1080p VP9 video.
const fixture = {
  id: "dQw4w9WgXcQ",
  title: "Rick Astley - Never Gonna Give You Up",
  extractor_key: "YouTube",
  duration: 212,
  thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  formats: [
    {
      format_id: "18",
      ext: "mp4",
      height: 360,
      fps: 30,
      vcodec: "avc1.42001E",
      acodec: "mp4a.40.2",
      tbr: 735.7,
      filesize: 1250000,
    },
    {
      format_id: "22",
      ext: "mp4",
      height: 720,
      fps: 30,
      vcodec: "avc1.64001F",
      acodec: "mp4a.40.2",
      tbr: 1340.0,
      filesize: 4500000,
    },
    {
      format_id: "137",
      ext: "mp4",
      height: 1080,
      fps: 30,
      vcodec: "avc1.640028",
      acodec: "none",
      tbr: 3042.0,
      filesize_approx: 8900000,
    },
    {
      format_id: "248",
      ext: "webm",
      height: 1080,
      fps: 30,
      vcodec: "vp9",
      acodec: "none",
      tbr: 2800.0,
      filesize_approx: 8200000,
    },
    {
      format_id: "140",
      ext: "m4a",
      height: null,
      fps: null,
      vcodec: "none",
      acodec: "mp4a.40.2",
      tbr: 129.0,
      filesize: 3400000,
    },
    {
      format_id: "251",
      ext: "webm",
      height: null,
      fps: null,
      vcodec: "none",
      acodec: "opus",
      tbr: 130.0,
      filesize_approx: 3500000,
    },
    {
      format_id: "fps60",
      ext: "mp4",
      height: 720,
      fps: 60,
      vcodec: "avc1.64002A",
      acodec: "none",
      tbr: 2100.0,
      filesize_approx: 7800000,
    },
  ],
};

test("qualityLabel reports real FPS", () => {
  assert.equal(qualityLabel(1080, 30), "1080p");
  assert.equal(qualityLabel(720, 60), "720p60");
  assert.equal(qualityLabel(0, 0), "audio");
});

test("buildFormatOptions maps only genuine streams", () => {
  const { formats, bestFormatId } = buildFormatOptions(fixture, 0);
  const qualities = formats.map((f) => f.quality);
  // 360p, 720p, 720p60, 1080p + audio — one entry per quality.
  assert.deepEqual([...new Set(qualities)].sort(), ["1080p", "360p", "720p", "720p60", "audio"]);
  assert.equal(qualities.length, new Set(qualities).size, "qualities must be unique");
  assert.ok(formats.some((f) => f.quality === "audio" && f.audio && !f.video));

  // 1080p mp4 (12.3 MB) is larger than the 1080p webm (11.7 MB) → mp4 kept.
  const f1080 = formats.find((f) => f.quality === "1080p");
  assert.ok(f1080, "1080p should appear once");
  assert.equal(f1080.container, "mp4");
  assert.equal(f1080.formatId, "137+140");
  assert.equal(f1080.fileSizeBytes, 8900000 + 3400000);

  // Highest resolution = 1080p; MP4 (h264) preferred for the MP4 result.
  assert.equal(bestFormatId, "137+140");
});

test("dedup keeps the largest file per quality", () => {
  const dupFixture = {
    ...fixture,
    formats: [
      ...fixture.formats,
      { format_id: "137b", ext: "mp4", height: 1080, fps: 30, vcodec: "avc1.640028", acodec: "none", tbr: 3050, filesize_approx: 9000000 },
    ],
  };
  const { formats } = buildFormatOptions(dupFixture, 0);
  const f1080s = formats.filter((f) => f.quality === "1080p");
  assert.equal(f1080s.length, 1);
  assert.equal(f1080s[0].formatId, "137b+140"); // larger file kept
  assert.equal(formats.filter((f) => f.quality === "720p").length, 1);
});

test("dedup prefers the most widely-playable codec at a quality", () => {
  const crossContainer = {
    ...fixture,
    formats: [
      { format_id: "v1080", ext: "mp4", height: 1080, fps: 30, vcodec: "avc1.640028", acodec: "none", tbr: 1000, filesize: 5000000 },
      { format_id: "v1080w", ext: "webm", height: 1080, fps: 30, vcodec: "vp9", acodec: "none", tbr: 2000, filesize: 9000000 },
      { format_id: "a1", ext: "m4a", height: null, vcodec: "none", acodec: "mp4a.40.2", tbr: 128, filesize: 1000000 },
      { format_id: "a2", ext: "webm", height: null, vcodec: "none", acodec: "opus", tbr: 128, filesize: 1000000 },
    ],
  };
  const { formats } = buildFormatOptions(crossContainer, 0);
  const f1080s = formats.filter((f) => f.quality === "1080p");
  assert.equal(f1080s.length, 1);
  // H.264 plays everywhere, so it wins even though the VP9 file is larger.
  assert.match(f1080s[0].formatId, /^v1080\+/);
  assert.equal(f1080s[0].container, "mp4");
});

test("dedup never hands 2K+ to AV1 when VP9 exists", () => {
  const av1Larger = {
    ...fixture,
    formats: [
      { format_id: "a140", ext: "m4a", height: null, vcodec: "none", acodec: "mp4a.40.2", tbr: 128, filesize: 3000000 },
      { format_id: "a251", ext: "webm", height: null, vcodec: "none", acodec: "opus", tbr: 130, filesize: 3000000 },
      // AV1 reports the LARGER file but is the least compatible codec.
      { format_id: "v2160av1", ext: "mp4", height: 2160, fps: 30, vcodec: "av01.0.12M.08", acodec: "none", tbr: 12000, filesize: 400000000 },
      { format_id: "v2160vp9", ext: "webm", height: 2160, fps: 30, vcodec: "vp9", acodec: "none", tbr: 11000, filesize_approx: 380000000 },
    ],
  };
  const { formats, bestFormatId } = buildFormatOptions(av1Larger, 0);
  const f2160 = formats.filter((f) => f.quality === "2160p");
  assert.equal(f2160.length, 1);
  // VP9 is chosen over AV1; it's delivered as MP4 after transcoding.
  assert.equal(f2160[0].container, "mp4");
  assert.equal(f2160[0].videoCodec, "vp9");
  assert.match(f2160[0].formatId, /^v2160vp9\+/);
  assert.match(bestFormatId, /^v2160vp9\+/);
});

test("no fake qualities are ever created", () => {
  const lowFixture = {
    ...fixture,
    formats: fixture.formats.filter((f) => f.height === null || f.height <= 360),
  };
  const { formats, bestFormatId } = buildFormatOptions(lowFixture, 0);
  for (const f of formats) {
    if (f.video) assert.ok(parseInt(f.quality, 10) <= 360, `never upscales: ${f.quality}`);
  }
  assert.notEqual(bestFormatId, "");
});

test("format size cap excludes oversized streams", () => {
  const { formats } = buildFormatOptions(fixture, 4000000);
  const oversized = formats.filter((f) => (f.fileSizeBytes || 0) > 4000000);
  assert.equal(oversized.length, 0);
  assert.ok(formats.some((f) => f.quality === "360p"));
});

test("extractVideoInfo exposes frontend fields only when present", () => {
  const info = extractVideoInfo(fixture);
  assert.equal(info.source, "YouTube");
  assert.equal(info.thumbnailUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(info.durationSeconds, 212);
  assert.match(info.title, /Rick Astley/);
});