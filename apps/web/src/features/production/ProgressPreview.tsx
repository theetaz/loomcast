import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { assetUrlQueryOptions } from "@/features/content-item/asset-url";

/**
 * A card's preview: a poster frame, or the first frame of a video. The asset's kind is not on the
 * card, so a URL that does not load as an image is shown as a muted video instead.
 */
export function ProgressPreview({ assetId, title }: { assetId: string; title: string }) {
  const url = useQuery(assetUrlQueryOptions(assetId));
  const [asVideo, setAsVideo] = useState(false);
  const frame = "block aspect-[9/16] w-full overflow-hidden rounded bg-secondary object-cover";

  if (!url.data) {
    return <div aria-hidden="true" className={frame} />;
  }
  return asVideo ? (
    <video
      src={url.data.url}
      muted
      playsInline
      preload="metadata"
      aria-label={`Preview of ${title}`}
      className={frame}
    />
  ) : (
    <img
      src={url.data.url}
      alt={`Preview of ${title}`}
      loading="lazy"
      className={frame}
      onError={() => setAsVideo(true)}
    />
  );
}
