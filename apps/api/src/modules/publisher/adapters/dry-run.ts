import { dryRunPermalink, type JsonObject, type Platform } from "@loomcast/contracts";
import { REDACTED, redactRequest } from "../redact";
import { buildPublishPlan, validatePublishRequest } from "../requests";
import type { PublisherAdapter, PublishResult } from "../types";

// The dry-run adapter stands in for every platform while a post is in dry-run. It builds the
// requests the live adapter would send, with the same builders, and records them on the attempt
// with credentials redacted. It never reads credentials, never copies media to the public bucket
// and never opens a connection: the media URLs point at the reserved `.invalid` domain.

/**
 * Origin of the media URLs a dry run records in place of the public copies a live run makes.
 * `.invalid` is reserved (RFC 2606) and never resolves.
 */
export const DRY_RUN_MEDIA_ORIGIN = "https://dry-run.invalid";

/** The placeholder public URL of a dry-run post's media: `https://dry-run.invalid/p/<postId>/<sha256>.<ext>`. */
export function dryRunMediaUrl(postId: string, sha256: string, ext: string): string {
  return `${DRY_RUN_MEDIA_ORIGIN}/p/${postId}/${sha256}.${ext}`;
}

/**
 * The dry-run adapter of `platform`. `validate` runs the platform's pure request checks;
 * `publish` records the publish plan and reports the post published at once with the
 * `dryrun://<platform>/<postId>` permalink.
 */
export function createDryRunAdapter(platform: Platform): PublisherAdapter {
  return {
    platform,

    async validate(context) {
      const request = await context.publishRequest();
      return [
        ...validatePublishRequest(request, context.media),
        ...context.caption().issues.map((issue) => ({ field: "caption", message: issue.message })),
      ];
    },

    async publish(context): Promise<PublishResult> {
      if (!context.dryRun) {
        throw new Error("the dry-run adapter only publishes dry-run posts");
      }
      const request = await context.publishRequest();
      const plan = buildPublishPlan({
        request,
        media: { bytes: context.media.bytes, mime: context.media.mime },
        accessToken: REDACTED,
      });
      const permalink = dryRunPermalink(platform, context.post.id);
      context.record({
        request: redactRequest(plan as unknown as JsonObject),
        response: { dryRun: true, permalink },
      });
      return { pending: false, permalink };
    },

    async status(context) {
      return { state: "published", permalink: dryRunPermalink(platform, context.post.id) };
    },
  };
}
