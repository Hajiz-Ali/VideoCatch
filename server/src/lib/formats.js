/* Builds the frontend-facing format list from a *real* yt-dlp JSON
 * info object. Nothing here is fabricated: every option maps to streams
 * yt-dlp actually reported. Quality labels are derived strictly from the
 * stream's own height/FPS, never guessed or upscaled. */

const MP4_GROUP = new Set(["mp4", "m4a", "mov"]);
const WEBM_GROUP = new Set(["webm", "ogg", "opus"]);

export function sortByHeightDesc(a, b) {
  return (b.height || 0) - (a.height || 0);
}

export function qualityLabel(height, fps) {
  if (!height || height <= 0) return "audio";
  const h = Math.round(height);
  const fpsNice = fps && fps > 30 ? Math.round(fps) : null;
  return fpsNice && fpsNice >= 60 ? `${h}p${fpsNice}` : `${h}p`;
}

function isAudio(f) {
  return f.acodec && f.acodec !== "none";
}

function isVideo(f) {
  return f.vcodec && f.vcodec !== "none";
}

function heightOf(f) {
  if (typeof f.height === "number" && f.height > 0) return f.height;
  return null;
}

function extOf(f) {
  return typeof f.ext === "string" && f.ext ? f.ext : "";
}

function sizeOf(f) {
  if (typeof f.filesize === "number" && f.filesize > 0) return f.filesize;
  if (typeof f.filesize_approx === "number" && f.filesize_approx > 0) return f.filesize_approx;
  // Fall back to bitrate estimate, only if no explicit size exists.
  const tbr = f.tbr || 0;
  const dur = f.duration || 0;
  if (tbr > 0 && dur > 0) return Math.round(tbr * 1000 / 8 * dur);
  return null;
}

function isMp4CompatibleVideo(vcodec) {
  if (!vcodec) return false;
  return /^(avc1|h264|avc|mp4v|hev1|hvc1|av01)/i.test(vcodec);
}

function isMp4CompatibleAudio(acodec) {
  if (!acodec) return false;
  return /^(mp4a|aac)/i.test(acodec);
}

/* Playback compatibility ranking for video codecs. Lower is more widely
 * supported: H.264 plays everywhere, VP9 in browsers/VLC, while HEVC and
 * especially AV1 are frequently undecodable (audio-only playback). */
const CODEC_RANK = [
  [/^(avc1|h264|avc|mp4v)/i, 0],
  [/^vp0?9/i, 1],
  [/^(hev1|hvc1|hevc|h265)/i, 2],
  [/^av01/i, 3],
];

function codecRank(vcodec) {
  if (!vcodec) return 2;
  for (const [re, rank] of CODEC_RANK) {
    if (re.test(vcodec)) return rank;
  }
  return 2;
}

/** Decide the container that best describes the merged result. */
function mergedContainer(video, audio) {
  const ve = extOf(video);
  const ae = extOf(audio);
  if (MP4_GROUP.has(ve) && MP4_GROUP.has(ae)) return "mp4";
  if (WEBM_GROUP.has(ve) && WEBM_GROUP.has(ae)) return "webm";
  if (MP4_GROUP.has(ve) && WEBM_GROUP.has(ae)) {
    // webm audio (opus) cannot be remuxed into mp4 without re-encoding.
    if (isMp4CompatibleAudio(audio.acodec)) return "mp4";
    return "mkv";
  }
  if (WEBM_GROUP.has(ve) && MP4_GROUP.has(ae)) {
    if (isMp4CompatibleVideo(video.vcodec)) return "mp4";
    return "mkv";
  }
  return "mkv";
}

function pickBestAudio(audioFormats) {
  if (!audioFormats.length) return null;
  const sorted = [...audioFormats].sort((a, b) => {
    const groupA = MP4_GROUP.has(extOf(a)) ? 0 : WEBM_GROUP.has(extOf(a)) ? 1 : 2;
    const groupB = MP4_GROUP.has(extOf(b)) ? 0 : WEBM_GROUP.has(extOf(b)) ? 1 : 2;
    if (groupA !== groupB) return groupA - groupB;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  return sorted[0];
}

/**
 * For a video-only stream, pick the best audio stream of the SAME
 * container family (mp4 video pairs with m4a/aac, webm with opus) so the
 * merged result keeps the video's own container. Falls back to the global
 * best audio (→ mkv) when nothing matches.
 */
function pickAudioForVideo(video, globalBest, audioFormats) {
  const ve = extOf(video);
  const wantMp4 = MP4_GROUP.has(ve);
  const wantWebm = WEBM_GROUP.has(ve);
  if (!wantMp4 && !wantWebm) return globalBest;
  const inFamily = audioFormats.filter((a) =>
    wantMp4 ? MP4_GROUP.has(extOf(a)) : wantWebm ? WEBM_GROUP.has(extOf(a)) : false
  );
  if (inFamily.length) return pickBestAudio(inFamily);
  return globalBest || null;
}

/**
 * @param {object} info  yt-dlp --dump-json output
 * @param {number} maxFormatSizeBytes  0 = unlimited
 * @returns {{ formats: Array, bestFormatId: string }}
 */
export function buildFormatOptions(info, maxFormatSizeBytes = 0) {
  const rawFormats = [...(Array.isArray(info.formats) ? info.formats : [])];
  if (!rawFormats.length && isVideo(info)) {
    // Some extractors only expose the single merged `info` object.
    rawFormats.push(info);
  }
  if (!rawFormats.length) return { formats: [], bestFormatId: "" };

  const audioCandidates = rawFormats.filter((f) => !isVideo(f) && isAudio(f));
  const bestAudio = pickBestAudio(audioCandidates);

  const options = [];
  const audioOnly = bestAudio
    ? {
        quality: "audio",
        container: MP4_GROUP.has(extOf(bestAudio)) ? "mp4" : extOf(bestAudio) || "mp4",
        ext: extOf(bestAudio),
        audio: true,
        video: false,
        fileSizeBytes: sizeOf(bestAudio),
        formatId: bestAudio.format_id,
        label: "Audio only",
      }
    : null;
  if (audioOnly && !exceedsCap(audioOnly.fileSizeBytes, maxFormatSizeBytes)) {
    options.push({ ...audioOnly, fmtObj: bestAudio });
  }

  const videoFormats = rawFormats.filter((f) => isVideo(f));
  for (const f of videoFormats) {
    const h = heightOf(f);
    if (h == null) continue;

    const base = {
      quality: qualityLabel(h, f.fps),
      fps: f.fps || null,
      height: h,
      videoCodec: f.vcodec || null,
      audioCodec: isAudio(f) ? f.acodec : null,
    };

    if (isAudio(f)) {
      // Progressive single-file stream (audio + video together).
      const option = {
        ...base,
        ext: extOf(f),
        container: MP4_GROUP.has(extOf(f)) ? "mp4" : extOf(f) || "mp4",
        audio: true,
        video: true,
        fileSizeBytes: sizeOf(f),
        formatId: f.format_id,
      };
      if (!exceedsCap(option.fileSizeBytes, maxFormatSizeBytes)) {
        options.push({ ...option, fmtObj: f });
      }
      continue;
    }

    // Video-only stream → merge with a compatible audio stream (if any).
    const audioForMerge = pickAudioForVideo(f, bestAudio, audioCandidates);
    const formatId = audioForMerge ? `${f.format_id}+${audioForMerge.format_id}` : f.format_id;
    const option = {
      ...base,
      ext: extOf(f),
      container: audioForMerge ? mergedContainer(f, audioForMerge) : extOf(f) || "mp4",
      audio: !!audioForMerge,
      video: true,
      fileSizeBytes:
        sizeOf(f) != null || audioForMerge == null
          ? addSizes(sizeOf(f), audioForMerge ? sizeOf(audioForMerge) : null)
          : null,
      formatId,
    };
    if (!exceedsCap(option.fileSizeBytes, maxFormatSizeBytes)) {
      options.push({ ...option, fmtObj: f });
    }
  }

  // Deduplicate by quality label so each resolution appears only once.
  // Keep the most widely-playable codec first (H.264 → VP9 → HEVC → AV1),
  // then the larger file, so 2K+ downloads don't land on an AV1/HEVC
  // stream that many players render as audio-only.
  const seen = new Map();
  for (const opt of options) {
    const key = opt.quality;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, opt);
      continue;
    }
    if (compareRichness(opt, existing) > 0) seen.set(key, opt);
  }
  let formats = [...seen.values()];
  formats.sort((a, b) => sortByHeightDesc(a, b) || (a.quality === "audio" ? 1 : -1));

  formats = formats.map(({ fmtObj, ...publicFields }) => {
    // Video is always delivered as MP4 (non-H.264 streams are transcoded
    // during download), so advertise the container users actually receive.
    return publicFields.video ? { ...publicFields, container: "mp4" } : publicFields;
  });

  // Best quality = the genuinely highest-resolution merged option.
  // Tie-break prefers the most widely-playable codec, then MP4 (h264)
  // so "Best" defaults to a file that actually plays everywhere.
  const best = formats
    .filter((f) => f.video)
    .sort(
      (a, b) =>
        (b.height || 0) - (a.height || 0) ||
        codecRank(a.videoCodec) - codecRank(b.videoCodec) ||
        (b.container === "mp4" ? 1 : 0) - (a.container === "mp4" ? 1 : 0) ||
        (b.fps || 0) - (a.fps || 0) ||
        (b.fileSizeBytes || 0) - (a.fileSizeBytes || 0)
    )[0];
  const bestFormatId = best ? best.formatId : audioOnly ? audioOnly.formatId : "";

  return { formats, bestFormatId };
}

function addSizes(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

function exceedsCap(sizeBytes, cap) {
  return cap > 0 && sizeBytes != null && sizeBytes > cap;
}

function compareRichness(a, b) {
  const rankA = codecRank(a.videoCodec);
  const rankB = codecRank(b.videoCodec);
  if (rankA !== rankB) return rankB - rankA; // more compatible codec wins
  const sizeA = a.fileSizeBytes || 0;
  const sizeB = b.fileSizeBytes || 0;
  if (sizeA !== sizeB) return sizeA - sizeB;
  // Equal (or unknown) sizes: prefer MP4 for best compatibility.
  if (a.container === "mp4" && b.container !== "mp4") return 1;
  if (b.container === "mp4" && a.container !== "mp4") return -1;
  return 0;
}

function humanizeKey(key) {
  if (!key) return "Unknown source";
  const special = { tophong: "TopFans", "xda": "XDA" };
  if (special[key]) return special[key];
  const words = key.replace(/[_-]+/g, " ").toLowerCase().split(" ").filter(Boolean);
  return words
    .map((w) => {
      if (w === "youtube") return "YouTube";
      if (w === "tiktok") return "TikTok";
      if (w === "instagram") return "Instagram";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export function extractVideoInfo(info) {
  return {
    title: typeof info.title === "string" ? info.title : null,
    source: humanizeKey(info.extractor_key || info.extractor),
    thumbnailUrl: normalizeThumb(info.thumbnail) || firstThumb(info.thumbnails),
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
  };
}

function normalizeThumb(t) {
  if (typeof t === "string" && /^https?:\/\//i.test(t)) return t;
  if (t && typeof t.url === "string" && /^https?:\/\//i.test(t.url)) return t.url;
  return null;
}

function firstThumb(thumbs) {
  if (!Array.isArray(thumbs)) return null;
  for (const t of thumbs) {
    if (typeof t?.url === "string" && /^https?:\/\//i.test(t.url)) return t.url;
  }
  return null;
}