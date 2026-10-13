import type { PublishRequest } from "@loomcast/contracts";
import { captionLength, countHashtags, PLATFORM_CAPTION_LIMITS } from "../../caption";
import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from "../../context";
import { UNCONNECTED_ACCOUNT_ID, validateInstagramRequest } from "../../requests";
import type { AdapterIssue, PublishContext } from "../../types";

// What Instagram accepts for a Reel published through the API, from the Reels specifications of
// the IG User media reference (Graph API v26.0, confirmed 2026-10-13):
// - MOV or MP4 container; HEVC or H.264 video (progressive, closed GOP, 4:2:0); AAC audio at up
//   to 48 kHz, mono or stereo;
// - 23 to 60 frames per second; at most 1920 columns; aspect ratio 0.01:1 to 10:1 (9:16, such as
//   1080×1920, recommended to avoid cropping);
// - video bit rate at most 25 Mbps (VBR), audio 128 kbps;
// - 3 seconds to 15 minutes; at most 300 MB;
// - caption at most 2,200 characters, 30 hashtags and 20 @ mentions.
// Duration, size, width, aspect ratio, container and mentions are checked by the shared request
// validator (`requests/instagram.ts`); this file adds the codec, frame rate, bit rate and caption
// checks. Probe facts the render does not report are not checked.

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

/** Origin of the stand-in video URL `validate` checks with; it never resolves (RFC 2606). */
const VALIDATE_ORIGIN = "https://validate.invalid";

/**
 * The request `validate` checks: the post as it would be sent, with a stand-in URL so nothing is
 * copied to public storage before the checks pass. Null when the render has no duration.
 */
function requestFor(context: PublishContext): PublishRequest | null {
  const { media } = context;
  if (media.durationMs === null || media.durationMs < 1) {
    return null;
  }
  return {
    platform: "instagram",
    externalId: context.channel.externalId ?? UNCONNECTED_ACCOUNT_ID,
    videoUrl: `${VALIDATE_ORIGIN}/${media.sha256}.mp4`,
    caption: context.caption().text,
    durationMs: media.durationMs,
    width: media.width ?? DEFAULT_RENDER_WIDTH,
    height: media.height ?? DEFAULT_RENDER_HEIGHT,
  };
}

function codecIssues(context: PublishContext): AdapterIssue[] {
  const probe = context.media.probe;
  if (probe === null || probe === undefined) {
    return [];
  }
  const issues: AdapterIssue[] = [];
  const limits = INSTAGRAM_REELS_MEDIA;
  if (probe.videoCodec !== undefined) {
    const codec = VIDEO_CODEC_ALIASES[probe.videoCodec.toLowerCase()];
    if (codec === undefined || !(limits.videoCodecs as readonly string[]).includes(codec)) {
      issues.push({
        field: "video",
        message: `The video codec ${probe.videoCodec} is not accepted; use H.264 or HEVC.`,
      });
    }
  }
  if (
    probe.audioCodec !== undefined &&
    !(limits.audioCodecs as readonly string[]).includes(probe.audioCodec.toLowerCase())
  ) {
    issues.push({
      field: "audio",
      message: `The audio codec ${probe.audioCodec} is not accepted; use AAC.`,
    });
  }
  if (probe.sampleRate !== undefined && probe.sampleRate > limits.maxSampleRate) {
    issues.push({ field: "audio", message: "The audio sample rate is above 48 kHz." });
  }
  if (probe.channels !== undefined && probe.channels > limits.maxAudioChannels) {
    issues.push({ field: "audio", message: "The audio has more than two channels." });
  }
  if (
    probe.fps !== undefined &&
    (probe.fps < limits.minFps - 0.5 || probe.fps > limits.maxFps + 0.5)
  ) {
    issues.push({
      field: "video",
      message: `The video runs at ${Math.round(probe.fps * 100) / 100} fps; it must run at 23 to 60 fps.`,
    });
  }
  if (probe.bitRate !== undefined && probe.bitRate > limits.maxBitRate) {
    issues.push({ field: "video", message: "The video bit rate is above 25 Mbps." });
  }
  return issues;
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
 * the codecs and rates of the probe, and the caption limits. Pure: no network, no storage.
 */
export function validateInstagramReel(context: PublishContext): AdapterIssue[] {
  const request = requestFor(context);
  const issues: AdapterIssue[] =
    request === null
      ? [{ field: "duration", message: "The render has no duration." }]
      : validateInstagramRequest(request, context.media);
  issues.push(...codecIssues(context), ...captionIssues(context));
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
