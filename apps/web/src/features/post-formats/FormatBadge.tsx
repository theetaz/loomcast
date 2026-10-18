import { POST_FORMAT_LABELS, type PostFormat } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import {
  ClapperboardIcon,
  GalleryHorizontalIcon,
  ImageIcon,
  type LucideIcon,
  SmartphoneIcon,
  TextIcon,
  TvMinimalPlayIcon,
} from "lucide-react";

// A post's format as a quiet icon, with or without its name. Lists show it beside the title; the
// accessible text always names the format, so the icon itself stays decorative.

export const FORMAT_ICONS: Record<PostFormat, LucideIcon> = {
  reel: ClapperboardIcon,
  video: TvMinimalPlayIcon,
  image: ImageIcon,
  carousel: GalleryHorizontalIcon,
  story: SmartphoneIcon,
  text: TextIcon,
};

export function formatLabel(format: PostFormat): string {
  return POST_FORMAT_LABELS[format] ?? format;
}

/**
 * The format's icon alone. Decorative unless `label` is set, which makes it an image named after
 * the format (and a tooltip), without adding to the text around it.
 */
export function FormatIcon({
  format,
  label = false,
  className,
}: {
  format: PostFormat;
  label?: boolean;
  className?: string;
}) {
  const Icon = FORMAT_ICONS[format] ?? ClapperboardIcon;
  return (
    <span
      data-format={format}
      {...(label
        ? { role: "img", "aria-label": formatLabel(format), title: formatLabel(format) }
        : { "aria-hidden": true })}
      className={cn("inline-flex shrink-0 text-muted-foreground", className)}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </span>
  );
}

/** The format's icon and name in a small outlined pill. */
export function FormatBadge({ format, className }: { format: PostFormat; className?: string }) {
  const Icon = FORMAT_ICONS[format] ?? ClapperboardIcon;
  return (
    <span
      data-format={format}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 font-medium text-[11.5px] text-text-2 shadow-[0_0_0_1px_var(--border)]",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3 text-muted-foreground" />
      {formatLabel(format)}
    </span>
  );
}
