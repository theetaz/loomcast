import { z } from "zod";
import { sanitizeMetaMessage } from "../../../../lib/meta-graph";
import { publishError } from "../../errors";
import type { StatusResult } from "../../types";

// `GET /{container-id}?fields=status,error_message` reports a Threads container as `IN_PROGRESS`,
// `FINISHED` (ready to publish), `PUBLISHED`, `ERROR` (with `error_message`, such as
// `FAILED_DOWNLOADING_VIDEO` or `INVALID_DURATION`) or `EXPIRED` (not published within 24 hours).

export const ThreadsContainerSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  status: z.string().optional(),
  error_message: z.string().optional(),
});
export type ThreadsContainer = z.infer<typeof ThreadsContainerSchema>;

export const ThreadsIdSchema = z.object({
  id: z.union([z.string().min(1), z.number()]).transform(String),
});

export const ThreadsPermalinkSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  permalink: z.string().optional(),
});

/** What a container's status means before publishing, or `ready` when it is FINISHED. */
export function threadsContainerState(container: ThreadsContainer): StatusResult | "ready" {
  switch (container.status) {
    case "FINISHED":
      return "ready";
    case "PUBLISHED":
      return { state: "published" };
    case "ERROR": {
      const reason = sanitizeMetaMessage(container.error_message ?? "").slice(0, 100);
      return {
        state: "failed",
        error: publishError(
          "invalid_media",
          reason === ""
            ? "The platform could not use the video."
            : `The platform could not use the video (${reason}).`,
          { retryable: false, ...(reason === "" ? {} : { platformCode: reason }) },
        ),
      };
    }
    case "EXPIRED":
      return {
        state: "failed",
        error: publishError("permanent", "The container expired before it was published.", {
          retryable: false,
          platformCode: "EXPIRED",
        }),
      };
    default:
      // IN_PROGRESS, or a status this adapter does not know yet: keep polling.
      return { state: "pending" };
  }
}
