import {
  type Channel,
  type MediaType,
  PHOTO_ONLY_CAROUSEL_PLATFORMS,
  PLATFORM_FORMATS,
  PLATFORMS,
  type Platform,
  POST_FORMATS,
  type PostFormat,
  platformSupportsFormat,
} from "@loomcast/contracts";

// Which channels can publish which formats, from the contracts' `PLATFORM_FORMATS`. The API
// refuses a format the channel's platform does not publish (`422 format_not_supported`); the web
// app leaves those channels out before it asks.

/** Channels a post can be scheduled on: every channel that is not switched off. */
export function schedulableChannels(channels: readonly Channel[]): Channel[] {
  return channels.filter((channel) => channel.status !== "disabled");
}

/** The platforms that publish `format`, in the product's order. */
export function platformsFor(format: PostFormat): Platform[] {
  return PLATFORMS.filter((platform) => platformSupportsFormat(platform, format));
}

/** Whether a carousel with these media can go to `platform` (Facebook takes photos only). */
function carouselFits(platform: Platform, media: readonly { type: MediaType }[]): boolean {
  return (
    !(PHOTO_ONLY_CAROUSEL_PLATFORMS as readonly Platform[]).includes(platform) ||
    media.every((entry) => entry.type === "image")
  );
}

/**
 * Whether `channel` can publish a post of `format` with `media`: its platform publishes the format,
 * and a carousel with a video skips platforms whose carousels take photos only.
 */
export function channelPublishes(
  channel: Pick<Channel, "platform">,
  format: PostFormat,
  media: readonly { type: MediaType }[] = [],
): boolean {
  if (!platformSupportsFormat(channel.platform, format)) return false;
  return format !== "carousel" || carouselFits(channel.platform, media);
}

/** The formats at least one of `channels` can publish, in the contracts' order. */
export function publishableFormats(channels: readonly Pick<Channel, "platform">[]): PostFormat[] {
  const platforms = new Set(channels.map((channel) => channel.platform));
  return POST_FORMATS.filter((format) =>
    [...platforms].some((platform) =>
      (PLATFORM_FORMATS[platform] as readonly PostFormat[]).includes(format),
    ),
  );
}
