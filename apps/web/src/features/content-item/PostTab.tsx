import { formatMediaIssues, PLATFORM_LABELS } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import { TriangleAlertIcon } from "lucide-react";
import { platformsFor } from "@/features/post-formats/channels";
import { FormatBadge } from "@/features/post-formats/FormatBadge";
import { PostPreview, type PreviewMedia } from "@/features/post-formats/MediaPreview";
import type { ItemTabProps } from "./tab-props";

/**
 * A composed post (photo, carousel, story, text post or uploaded video): the post as it will look,
 * its caption, the platforms that publish its format and, until its media fit the format, what is
 * still missing.
 */
export function PostTab({ version }: ItemTabProps) {
  const media: PreviewMedia[] = version.media.map((entry, index) => ({
    key: `${entry.assetId}:${index}`,
    type: entry.type,
    assetId: entry.assetId,
    altText: entry.altText,
  }));
  const issues = formatMediaIssues(version);
  const platforms = platformsFor(version.format);
  const photos = version.media.filter((entry) => entry.type === "image");
  const missingAlt = photos.filter((entry) => !entry.altText?.trim()).length;

  return (
    <div className="grid gap-5 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
      <PostPreview format={version.format} media={media} caption={version.caption} />
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="font-semibold text-[13px]">Details</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-small">
          <dt className="text-muted-foreground">Format</dt>
          <dd>
            <FormatBadge format={version.format} />
          </dd>
          <dt className="text-muted-foreground">Publishes to</dt>
          <dd className="min-w-0 break-words">
            {platforms.map((platform) => PLATFORM_LABELS[platform]).join(", ")}
          </dd>
          {version.format !== "text" ? (
            <>
              <dt className="text-muted-foreground">Items</dt>
              <dd className="tabular-nums">{version.media.length}</dd>
            </>
          ) : null}
          {photos.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Alt text</dt>
              <dd className={cn(missingAlt > 0 && "text-status-amber")}>
                {missingAlt === 0
                  ? "Every photo"
                  : `${missingAlt} of ${photos.length} ${photos.length === 1 ? "photo" : "photos"} without`}
              </dd>
            </>
          ) : null}
        </dl>
        {issues.length > 0 ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md bg-status-amber/11 px-2.5 py-2 text-small text-status-amber"
          >
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <ul className="flex flex-col gap-0.5">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {photos.length > missingAlt ? (
          <p className="text-small text-text-4">
            Hover over or focus a photo to read its alt text.
          </p>
        ) : null}
      </div>
    </div>
  );
}
