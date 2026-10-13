import { type AssetDetail, STORYBOARD_FPS } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FilmIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { formatDuration } from "@/features/library/format";
import { errorMessage, isApiError } from "@/lib/api";
import { assetUrlQueryOptions, useAssetUrl, useMediaSource } from "./asset-url";
import { formatBitRate, formatBytes, formatChannels, formatSampleRate } from "./media-format";
import { assetQueryOptions } from "./queries";
import type { ItemTabProps } from "./tab-props";

export const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;

/** Moves a video one frame back or forward, pausing it first. */
export function stepFrame(video: HTMLVideoElement, direction: -1 | 1, fps: number) {
  video.pause();
  const next = video.currentTime + direction / fps;
  const end = Number.isFinite(video.duration) ? video.duration : next;
  video.currentTime = Math.min(Math.max(0, next), end);
}

/**
 * The rendered video in a 9:16 frame with its poster. It never plays on its own. `,` and `.` step
 * one frame while the player has focus; the rate buttons change the speed. Below: the file's
 * technical details and a download.
 */
export function VideoTab({ version, decisions, viewingCurrent }: ItemTabProps) {
  const renderId = version.renderAssetId;
  if (!renderId) {
    return (
      <EmptyState
        size="compact"
        icon={FilmIcon}
        title="Not rendered yet"
        description="The video appears here once the studio agent renders the storyboard with the voice."
        action={
          decisions.can("render") && viewingCurrent ? (
            <Button
              type="button"
              disabled={decisions.busy || decisions.hasActiveJob}
              onClick={() => decisions.start("render")}
            >
              Render the video
            </Button>
          ) : null
        }
      />
    );
  }
  return <VideoPreview key={renderId} renderId={renderId} posterId={version.posterAssetId} />;
}

function VideoPreview({ renderId, posterId }: { renderId: string; posterId: string | null }) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [rate, setRate] = useState<number>(1);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const asset = useQuery(assetQueryOptions(renderId));
  const source = useAssetUrl(renderId);
  const poster = useAssetUrl(posterId);
  useMediaSource(videoRef, source.data?.url);
  const fps = asset.data?.probe?.fps || STORYBOARD_FPS;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "," || event.key === ".") {
      event.preventDefault();
      stepFrame(video, event.key === "," ? -1 : 1, fps);
    }
  };

  const changeRate = (next: number) => {
    setRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const download = async () => {
    setDownloading(true);
    try {
      const link = await queryClient.fetchQuery(assetUrlQueryOptions(renderId, "attachment"));
      const anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.download = asset.data?.filename ?? "video.mp4";
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      toast.error("Couldn't start the download", { description: errorMessage(error) });
    } finally {
      setDownloading(false);
    }
  };

  const processing = source.isError && isApiError(source.error, 409);

  return (
    <div className="grid gap-5 px-4 py-4 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2.5">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the frame-step keys come from the focused video inside. */}
        <div
          onKeyDown={onKeyDown}
          className="relative mx-auto aspect-[9/16] w-full max-w-[320px] overflow-hidden rounded-lg bg-[#0b0b10] shadow-card"
        >
          {/* biome-ignore lint/a11y/useMediaCaption: renders burn their captions into the picture. */}
          <video
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            poster={poster.data?.url}
            aria-label="Rendered video"
            aria-keyshortcuts=", ."
            onError={() => source.data && setFailed(true)}
            onLoadedMetadata={(event) => {
              setFailed(false);
              event.currentTarget.playbackRate = rate;
            }}
            className="absolute inset-0 size-full object-contain outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
          {processing ? (
            <p className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-2 text-center text-small text-white">
              The video is still being processed.
            </p>
          ) : null}
        </div>
        {failed ? (
          <p role="alert" className="flex items-center gap-1.5 text-small text-destructive">
            <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
            The video couldn't be loaded.
            <button
              type="button"
              className="underline"
              onClick={() => {
                setFailed(false);
                void source.refetch();
              }}
            >
              Try again
            </button>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous frame"
            title="Previous frame (,)"
            onClick={() => videoRef.current && stepFrame(videoRef.current, -1, fps)}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next frame"
            title="Next frame (.)"
            onClick={() => videoRef.current && stepFrame(videoRef.current, 1, fps)}
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
          <fieldset className="flex items-center rounded-md bg-secondary p-0.5">
            <legend className="sr-only">Playback speed</legend>
            {PLAYBACK_RATES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={rate === value}
                onClick={() => changeRate(value)}
                className={cn(
                  "h-6 rounded-[5px] px-2 font-medium text-[11.5px] text-muted-foreground tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  rate === value ? "bg-card text-foreground shadow-card" : "hover:text-foreground",
                )}
              >
                {value}×
              </button>
            ))}
          </fieldset>
        </div>
        <p className="text-center text-small text-text-4">
          Focus the video, then <kbd className="font-mono">,</kbd> and{" "}
          <kbd className="font-mono">.</kbd> step one frame.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-[13px]">Details</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={downloading}
            onClick={() => void download()}
          >
            <DownloadIcon aria-hidden="true" />
            {downloading ? "Preparing…" : "Download"}
          </Button>
        </div>
        {asset.isPending ? (
          <div aria-hidden="true" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : asset.isError ? (
          <p className="text-small text-destructive">
            {errorMessage(asset.error, "Couldn't load the file details.")}
          </p>
        ) : (
          <TechnicalDetails asset={asset.data} />
        )}
      </div>
    </div>
  );
}

function TechnicalDetails({ asset }: { asset: AssetDetail }) {
  const probe = asset.probe;
  const rows: [string, string][] = [
    ["File", asset.filename],
    ["Resolution", asset.width && asset.height ? `${asset.width} × ${asset.height}` : "Unknown"],
    ["Length", asset.durationMs !== null ? formatDuration(asset.durationMs) : "Unknown"],
    ["Frame rate", probe?.fps ? `${probe.fps} fps` : "Unknown"],
    ["Video", probe?.videoCodec ?? "Unknown"],
    [
      "Audio",
      probe?.audioCodec
        ? [
            probe.audioCodec,
            probe.sampleRate ? formatSampleRate(probe.sampleRate) : null,
            probe.channels ? formatChannels(probe.channels) : null,
          ]
            .filter(Boolean)
            .join(", ")
        : "None",
    ],
    ["Bit rate", probe?.bitRate ? formatBitRate(probe.bitRate) : "Unknown"],
    ["Size", formatBytes(asset.bytes)],
    ["SHA-256", `${asset.sha256.slice(0, 12)}…`],
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-small">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd
            className={cn(
              "min-w-0 break-words text-foreground",
              (label === "SHA-256" || label === "File") && "font-mono text-mono",
            )}
            title={label === "SHA-256" ? asset.sha256 : undefined}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
