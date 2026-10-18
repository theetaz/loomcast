import {
  type Channel,
  type MediaType,
  PLATFORM_FORMATS,
  PLATFORMS,
  type Platform,
  POST_FORMATS,
  type PostFormat,
  platformRefusal,
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

/**
 * Whether `channel` can publish a post of `format` with `media`: its platform publishes the format,
 * and a carousel with a video skips platforms whose carousels take photos only.
 */
export function channelPublishes(
  channel: Pick<Channel, "platform">,
  format: PostFormat,
  media: readonly { type: MediaType }[] = [],
): boolean {
  return platformRefusal(channel.platform, { format, media }) === null;
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
