import type { MediaType, PostFormat } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { ChevronLeftIcon, ChevronRightIcon, ImageIcon, LinkIcon, VideoIcon } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from "react";
import { useAssetUrl, useMediaSource } from "@/features/content-item/asset-url";

// How a composed post will look: one photo, a carousel stepped one item at a time, a 9:16 story,
// a text post with its link, or an uploaded video. The same previews serve the item page (ready
// assets, through presigned URLs) and the composer (local files, through object URLs).

/** One photo or video to preview. */
export interface PreviewMedia {
  key: string;
  type: MediaType;
  altText?: string | undefined;
  /** A ready asset, shown through a presigned URL that is refreshed before it expires. */
  assetId?: string | undefined;
  /** A local object URL, for a file not uploaded yet. */
  url?: string | undefined;
}

/** A swipe shorter than this many pixels is a tap, not a step. */
export const SWIPE_THRESHOLD_PX = 40;

export interface PostPreviewProps {
  format: PostFormat;
  media: readonly PreviewMedia[];
  caption?: string | null;
  /** The link of a text post, shown as a card. */
  link?: string | null;
  className?: string;
}

/** The post as it will look, by format. */
export function PostPreview({ format, media, caption, link, className }: PostPreviewProps) {
  return (
    <div data-preview={format} className={cn("flex flex-col gap-3", className)}>
      {format === "text" ? (
        <TextPreview caption={caption ?? ""} link={link ?? null} />
      ) : media.length === 0 ? (
        <EmptyFrame format={format} />
      ) : format === "carousel" ? (
        <CarouselPreview media={media} />
      ) : (
        <SingleFrame format={format} entry={media[0] as PreviewMedia} />
      )}
      {format !== "text" && caption ? (
        <p className="whitespace-pre-wrap break-words text-body text-text-2">{caption}</p>
      ) : null}
    </div>
  );
}

/** The shape of each format's frame: feed photos 4:5, stories and Reels 9:16, videos 16:9. */
function frameClass(format: PostFormat): string {
  if (format === "story" || format === "reel") return "aspect-[9/16] w-full max-w-[280px]";
  if (format === "video") return "aspect-video w-full";
  return "aspect-[4/5] w-full max-w-[400px]";
}

function EmptyFrame({ format }: { format: PostFormat }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center self-center rounded-lg bg-secondary text-text-4 shadow-[0_0_0_1px_var(--border)]",
        frameClass(format),
      )}
    >
      <ImageIcon aria-hidden="true" className="size-6" />
      <span className="sr-only">No photos or videos yet</span>
    </div>
  );
}

function SingleFrame({ format, entry }: { format: PostFormat; entry: PreviewMedia }) {
  return (
    <div className={cn("self-center", frameClass(format))}>
      <MediaFrame entry={entry} label={format === "story" ? "Story" : undefined} />
    </div>
  );
}

/**
 * The items of a carousel one at a time: Previous and Next, the arrow keys while focus is inside, or
 * a swipe. Steps slide over 220 ms; under reduced motion they switch at once. At either end the
 * buttons stay focusable (`aria-disabled`), so keyboard focus is never dropped.
 */
export function CarouselPreview({ media }: { media: readonly PreviewMedia[] }) {
  const [index, setIndex] = useState(0);
  const start = useRef<number | null>(null);
  const counterId = useId();
  const count = media.length;
  const current = Math.min(index, count - 1);
  const go = (next: number) => setIndex(Math.max(0, Math.min(count - 1, next)));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(current - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(current + 1);
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    start.current = event.clientX;
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    const moved = event.clientX - start.current;
    start.current = null;
    if (Math.abs(moved) >= SWIPE_THRESHOLD_PX) go(current + (moved < 0 ? 1 : -1));
  };

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Carousel preview"
      aria-describedby={counterId}
      onKeyDown={onKeyDown}
      className="flex w-full max-w-[400px] flex-col gap-2 self-center"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          start.current = null;
        }}
        className="relative aspect-[4/5] w-full touch-pan-y overflow-hidden rounded-lg"
      >
        <div
          className="flex h-full transition-transform duration-220 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${current * 100}%)` }}
        >
          {media.map((entry, position) => (
            // biome-ignore lint/a11y/useSemanticElements: a carousel slide is a group, not a form fieldset.
            <div
              key={entry.key}
              role="group"
              aria-roledescription="slide"
              aria-label={`${position + 1} of ${count}`}
              aria-hidden={position !== current || undefined}
              inert={position !== current || undefined}
              className="h-full w-full shrink-0"
            >
              <MediaFrame entry={entry} rounded={false} />
            </div>
          ))}
        </div>
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[11px] text-white tabular-nums"
        >
          {current + 1}/{count}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Previous item"
          aria-disabled={current === 0 || undefined}
          className="aria-disabled:opacity-50"
          onClick={() => go(current - 1)}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <span aria-hidden="true" className="flex flex-1 items-center justify-center gap-1">
          {media.map((entry, position) => (
            <span
              key={entry.key}
              className={cn(
                "size-1.5 rounded-full transition-colors motion-reduce:transition-none",
                position === current ? "bg-primary" : "bg-border",
              )}
            />
          ))}
        </span>
        <p id={counterId} aria-live="polite" className="sr-only">
          Item {current + 1} of {count}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Next item"
          aria-disabled={current === count - 1 || undefined}
          className="aria-disabled:opacity-50"
          onClick={() => go(current + 1)}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

/** The words of a text post and its link as a preview card. */
function TextPreview({ caption, link }: { caption: string; link: string | null }) {
  let host: string | null = null;
  if (link) {
    try {
      host = new URL(link).hostname;
    } catch {
      host = null;
    }
  }
  return (
    <div className="flex w-full max-w-[460px] flex-col gap-3 self-center rounded-lg bg-card p-3.5 shadow-card">
      {caption ? (
        <p className="whitespace-pre-wrap break-words text-body">{caption}</p>
      ) : (
        <p className="text-body text-text-4">The post's text appears here.</p>
      )}
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer noopener"
          className="flex min-w-0 items-center gap-2.5 rounded-md bg-secondary px-3 py-2.5 shadow-[0_0_0_1px_var(--border)] outline-none hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LinkIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            {host ? (
              <span className="truncate font-medium text-control uppercase tracking-wide text-muted-foreground">
                {host}
              </span>
            ) : null}
            <span className="truncate text-control text-primary">{link}</span>
          </span>
        </a>
      ) : null}
    </div>
  );
}

/**
 * One photo or video filling its frame. A photo with alt text shows it over the bottom of the photo
 * on hover and keyboard focus, so the owner can check it; screen readers read it as the image's
 * alternative text.
 */
export function MediaFrame({
  entry,
  label,
  rounded = true,
}: {
  entry: PreviewMedia;
  /** A corner label, such as "Story". */
  label?: string | undefined;
  rounded?: boolean;
}) {
  const remote = useAssetUrl(entry.url ? null : entry.assetId);
  const src = entry.url ?? remote.data?.url;
  const alt = entry.altText?.trim() ?? "";
  const failed = remote.isError && !entry.url;

  return (
    <figure
      data-media-type={entry.type}
      // A photo with alt text takes focus so keyboard users can read it too.
      tabIndex={alt && entry.type === "image" ? 0 : undefined}
      className={cn(
        "group/media relative m-0 h-full w-full overflow-hidden bg-secondary shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        rounded && "rounded-lg",
      )}
    >
      {src ? (
        entry.type === "image" ? (
          <img
            src={src}
            alt={alt}
            decoding="async"
            draggable={false}
            className="size-full object-cover"
          />
        ) : (
          <PreviewVideo src={src} label={alt || "Video"} />
        )
      ) : (
        <span className="flex size-full items-center justify-center text-text-4">
          {entry.type === "image" ? (
            <ImageIcon aria-hidden="true" className="size-5" />
          ) : (
            <VideoIcon aria-hidden="true" className="size-5" />
          )}
          <span className="sr-only">{failed ? "Couldn't load this file" : "Loading the file"}</span>
        </span>
      )}
      {label ? (
        <span className="absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 font-medium text-[11px] text-white">
          {label}
        </span>
      ) : null}
      {alt && entry.type === "image" ? (
        <figcaption
          aria-hidden="true"
          data-alt-text=""
          className={cn(
            "absolute inset-x-0 bottom-0 bg-black/70 px-2.5 py-2 text-small text-white",
            "opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
            "group-hover/media:opacity-100 group-focus-visible/media:opacity-100",
          )}
        >
          <span className="mr-1.5 rounded-sm bg-white/20 px-1 font-mono text-[10px]">ALT</span>
          {alt}
        </figcaption>
      ) : null}
    </figure>
  );
}

function PreviewVideo({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useMediaSource(ref, src);
  return (
    // biome-ignore lint/a11y/useMediaCaption: previews of uploaded media carry no caption track.
    <video
      ref={ref}
      aria-label={label}
      controls
      playsInline
      preload="metadata"
      className="size-full bg-black object-contain"
    />
  );
}
