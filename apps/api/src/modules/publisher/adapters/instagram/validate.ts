import {
  type AssetProbe,
  type MediaPublishRequest,
  PLATFORM_LABELS,
  POST_FORMAT_LABELS,
  type PublishRequest,
  type VideoPublishRequest,
} from "@loomcast/contracts";
import { extensionForMime } from "../../../../lib/storage/keys";
import { captionLength, countHashtags, PLATFORM_CAPTION_LIMITS } from "../../caption";
import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from "../../context";
import { videoFacts } from "../../media";
import { UNCONNECTED_ACCOUNT_ID, validateInstagramRequest } from "../../requests";
import type { AdapterIssue, PublishContext } from "../../types";

// What Instagram accepts for a post published through the API, from the IG User media reference
// (Graph API v26.0; Reels confirmed 2026-10-13, photos, carousels and stories 2026-10-18):
// - Reels: MOV or MP4 container; HEVC or H.264 video (progressive, closed GOP, 4:2:0); AAC audio
//   at up to 48 kHz, mono or stereo; 23 to 60 frames per second; at most 1920 columns; aspect
//   ratio 0.01:1 to 10:1 (9:16, such as 1080×1920, recommended to avoid cropping); video bit rate
//   at most 25 Mbps (VBR), audio 128 kbps; 3 seconds to 15 minutes; at most 300 MB;
// - story videos: the same codecs and frame rates, 3 to 60 seconds, at most 100 MB;
// - photos (feed, carousel and story): JPEG only, at most 8 MB;
// - caption at most 2,200 characters, 30 hashtags and 20 @ mentions (stories take none).
// Durations, sizes, dimensions, aspect ratios, file types, item counts and mentions are checked
// by the shared request validator (`requests/instagram.ts`); this file adds the codec, frame
// rate, bit rate and caption checks. Probe facts an upload does not report are not checked; the
// carousel video codecs are not documented any more, so they get the Reels checks.

export const INSTAGRAM_REELS_MEDIA = {
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  minFps: 23,
  maxFps: 60,
  maxSampleRate: 48_000,
  maxAudioChannels: 2,
  /** 25 Mbps of video plus 128 kbps of audio, against the probe's overall bit rate. */
  maxBitRate: 25_000_000 + 128_000,
} as const;

/** ffprobe codec names that mean H.264 or HEVC. */
const VIDEO_CODEC_ALIASES: Record<string, string> = {
  h264: "h264",
  avc: "h264",
  avc1: "h264",
  hevc: "hevc",
  h265: "hevc",
  hvc1: "hevc",
  hev1: "hevc",
};

/** Origin of the stand-in media URLs `validate` checks with; it never resolves (RFC 2606). */
const VALIDATE_ORIGIN = "https://validate.invalid";

function base(context: PublishContext) {
  return {
    platform: "instagram" as const,
    externalId: context.channel.externalId ?? UNCONNECTED_ACCOUNT_ID,
    caption: context.caption().text,
    ...(Object.keys(context.post.options).length === 0 ? {} : { options: context.post.options }),
  };
}

/**
 * The request `validate` checks: the post as it would be sent, with stand-in URLs so nothing is
 * copied to public storage before the checks pass. Null when a Reel's video has no duration.
 */
function requestFor(context: PublishContext): PublishRequest | null {
  const { media } = context;
  if (media.format === "reel" || media.format === "video") {
    const video = media.video;
    if (video === null || video.durationMs === null || video.durationMs < 1) {
      return null;
    }
    const request: VideoPublishRequest = {
      ...base(context),
      format: media.format,
      videoUrl: `${VALIDATE_ORIGIN}/${video.sha256}.mp4`,
      ...(media.posterAssetId === null ? {} : { posterUrl: `${VALIDATE_ORIGIN}/poster.jpg` }),
      durationMs: video.durationMs,
      width: video.width ?? DEFAULT_RENDER_WIDTH,
      height: video.height ?? DEFAULT_RENDER_HEIGHT,
    };
    return request;
  }
  if (media.format === "text") {
    return { ...base(context), format: "text" };
  }
  const request: MediaPublishRequest = {
    ...base(context),
    format: media.format,
    media: media.items.map((item) => ({
      type: item.type,
      url: `${VALIDATE_ORIGIN}/${item.sha256}.${extensionForMime(item.mime)}`,
      mime: item.mime,
      bytes: item.bytes,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
      ...(item.altText === undefined || item.altText === "" ? {} : { altText: item.altText }),
    })),
  };
  return request;
}

/** The codec, rate and channel checks of one video's probe; `name` starts each message. */
function codecIssues(
  probe: AssetProbe | null | undefined,
  field: string,
  name: string,
): AdapterIssue[] {
  if (probe === null || probe === undefined) {
    return [];
  }
  const issues: AdapterIssue[] = [];
  const limits = INSTAGRAM_REELS_MEDIA;
  if (probe.videoCodec !== undefined) {
    const codec = VIDEO_CODEC_ALIASES[probe.videoCodec.toLowerCase()];
    if (codec === undefined || !(limits.videoCodecs as readonly string[]).includes(codec)) {
      issues.push({
        field,
        message: `${name} codec ${probe.videoCodec} is not accepted; use H.264 or HEVC.`,
      });
    }
  }
  if (
    probe.audioCodec !== undefined &&
    !(limits.audioCodecs as readonly string[]).includes(probe.audioCodec.toLowerCase())
  ) {
    issues.push({
      field: field === "video" ? "audio" : field,
      message: `The audio codec ${probe.audioCodec} is not accepted; use AAC.`,
    });
  }
  if (probe.sampleRate !== undefined && probe.sampleRate > limits.maxSampleRate) {
    issues.push({
      field: field === "video" ? "audio" : field,
      message: "The audio sample rate is above 48 kHz.",
    });
  }
  if (probe.channels !== undefined && probe.channels > limits.maxAudioChannels) {
    issues.push({
      field: field === "video" ? "audio" : field,
      message: "The audio has more than two channels.",
    });
  }
  if (
    probe.fps !== undefined &&
    (probe.fps < limits.minFps - 0.5 || probe.fps > limits.maxFps + 0.5)
  ) {
    issues.push({
      field,
      message: `${name} runs at ${Math.round(probe.fps * 100) / 100} fps; it must run at 23 to 60 fps.`,
    });
  }
  if (probe.bitRate !== undefined && probe.bitRate > limits.maxBitRate) {
    issues.push({ field, message: `${name} bit rate is above 25 Mbps.` });
  }
  return issues;
}

/** The probe checks of the post's videos: the Reel's video, or each video item. */
function probeIssues(context: PublishContext): AdapterIssue[] {
  const { media } = context;
  if (media.format === "reel") {
    return codecIssues(media.video?.probe, "video", "The video");
  }
  return media.items.flatMap((item, index) =>
    item.type === "video"
      ? codecIssues(
          item.probe,
          `media.${index}`,
          media.items.length === 1 ? "The video" : `Video ${index + 1}`,
        )
      : [],
  );
}

function captionIssues(context: PublishContext): AdapterIssue[] {
  const caption = context.caption();
  const limits = PLATFORM_CAPTION_LIMITS.instagram;
  const issues: AdapterIssue[] = caption.issues.map((issue) => ({
    field: "caption",
    message: issue.message,
  }));
  if (captionLength("instagram", caption.text) > limits.maxLength) {
    issues.push({
      field: "caption",
      message: `The caption is longer than ${limits.maxLength} characters.`,
    });
  }
  if (limits.maxHashtags !== null && countHashtags(caption.text) > limits.maxHashtags) {
    issues.push({
      field: "caption",
      message: `The caption has more than ${limits.maxHashtags} hashtags.`,
    });
  }
  return issues;
}

/**
 * What Instagram would refuse in the post: the shared request checks (as the dry run runs them),
 * the codecs and rates of the probes, and the caption limits (except for stories, which are sent
 * without a caption). Pure: no network, no storage.
 */
export function validateInstagramPost(context: PublishContext): AdapterIssue[] {
  const { format } = context.media;
  if (format === "video" || format === "text") {
    return [
      {
        field: "format",
        message: `${PLATFORM_LABELS.instagram} does not publish ${POST_FORMAT_LABELS[format].toLowerCase()}s.`,
      },
    ];
  }
  const request = requestFor(context);
  const issues: AdapterIssue[] =
    request === null
      ? [{ field: "duration", message: "The render has no duration." }]
      : validateInstagramRequest(request, videoFacts(context.media));
  issues.push(...probeIssues(context));
  if (format !== "story") {
    issues.push(...captionIssues(context));
  }
  // The shared validator and the fitted caption may report the same mention limit.
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.field}\u0000${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
