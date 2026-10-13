import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { FilmIcon } from "lucide-react";
import { useState } from "react";
import { assetUrlQueryOptions } from "./queries";

/**
 * A video's poster as a small 9:16 thumbnail, from a presigned URL that is refreshed before it
 * expires. Without a poster, or while it loads, a quiet placeholder keeps the row's shape. The
 * image is decorative: the row names the video.
 */
export function Poster({ assetId, className }: { assetId: string | null; className?: string }) {
  const url = useQuery({ ...assetUrlQueryOptions(assetId ?? ""), enabled: assetId !== null });
  const [failed, setFailed] = useState<string | null>(null);
  const src = url.data?.url;
  const show = src !== undefined && failed !== src;

  return (
    <span
      className={cn(
        "relative flex aspect-[9/16] shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-secondary shadow-[0_0_0_1px_var(--border)]",
        className,
      )}
    >
      {show ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(src)}
          className="size-full object-cover"
        />
      ) : (
        <FilmIcon aria-hidden="true" className="size-3.5 text-text-4" />
      )}
    </span>
  );
}
