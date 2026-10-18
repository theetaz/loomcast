import { PublishFailure } from "./errors";
import type { MediaFacts } from "./requests/types";
import type { PublishFile, PublishMedia } from "./types";

// Reading a post's media by format: the video of a `reel` or `video` post.

/**
 * The video of a `reel` or `video` post. Throws `PublishFailure` (`invalid_media`) when the post
 * has none, such as a photo post sent down a video path.
 */
export function videoOf(media: PublishMedia): PublishFile {
  if (media.video === null) {
    throw PublishFailure.of("invalid_media", `A ${media.format} post has no video to publish.`, {
      retryable: false,
    });
  }
  return media.video;
}

/** The size and type of a video post's video, for the request builders; null for other posts. */
export function videoFacts(media: PublishMedia): MediaFacts | null {
  return media.video === null ? null : { bytes: media.video.bytes, mime: media.video.mime };
}
