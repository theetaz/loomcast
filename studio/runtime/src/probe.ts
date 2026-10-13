import { type CommandRunner, runChecked, runCommand } from "./process.ts";

// Media metadata from ffprobe, in the shape the studio agent reports when it finalizes an asset.

export interface MediaProbe {
  durationMs: number;
  sizeBytes: number;
  formatName: string;
  video?: {
    codec: string;
    profile?: string;
    width: number;
    height: number;
    fps: number;
    pixelFormat?: string;
  };
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitRate?: number;
  };
}

export interface ProbeOptions {
  ffprobePath?: string;
  run?: CommandRunner;
  signal?: AbortSignal;
}

/** The arguments for an ffprobe JSON report; `-v error` first, the path last. */
export function probeArgs(path: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path];
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  duration?: string;
}

interface RawProbe {
  streams?: RawStream[];
  format?: { duration?: string; size?: string; format_name?: string };
}

function rate(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return 0;
  if (den === undefined) return num;
  return den > 0 ? num / den : 0;
}

/** Turns ffprobe's JSON into a `MediaProbe`. */
export function parseProbe(json: string): MediaProbe {
  const raw = JSON.parse(json) as RawProbe;
  const streams = raw.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const seconds = Number(raw.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const probe: MediaProbe = {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    sizeBytes: Number(raw.format?.size ?? 0) || 0,
    formatName: raw.format?.format_name ?? "unknown",
  };
  if (video) {
    probe.video = {
      codec: video.codec_name ?? "unknown",
      ...(video.profile ? { profile: video.profile } : {}),
      width: video.width ?? 0,
      height: video.height ?? 0,
      fps: Math.round(rate(video.avg_frame_rate ?? video.r_frame_rate) * 1000) / 1000,
      ...(video.pix_fmt ? { pixelFormat: video.pix_fmt } : {}),
    };
  }
  if (audio) {
    probe.audio = {
      codec: audio.codec_name ?? "unknown",
      sampleRate: Number(audio.sample_rate ?? 0) || 0,
      channels: audio.channels ?? 0,
      ...(audio.bit_rate ? { bitRate: Number(audio.bit_rate) } : {}),
    };
  }
  return probe;
}

/** Reads a media file's duration, streams and size with ffprobe. */
export async function probeMedia(path: string, options: ProbeOptions = {}): Promise<MediaProbe> {
  const ffprobe = options.ffprobePath ?? "ffprobe";
  const result = await runChecked(options.run ?? runCommand, "ffprobe", ffprobe, probeArgs(path), {
    signal: options.signal,
  });
  return parseProbe(result.stdout);
}
