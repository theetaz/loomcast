import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { ActorKindSchema, ReviewDecisionSchema } from "../enums";
import { CursorPageQuerySchema } from "./common";
import { ContentItemSchema } from "./content";

export const REVIEW_COMMENT_MAX_LENGTH = 5_000;

/** A decision on one version of an item. */
export const ReviewSchema = z.object({
  id: IdSchema,
  itemId: IdSchema,
  versionId: IdSchema,
  decision: ReviewDecisionSchema,
  comment: z.string().nullable(),
  /** For `request_changes`: whether a producer revision was queued from the comment. */
  enqueueRevision: z.boolean(),
  userId: IdSchema.nullable(),
  actorKind: ActorKindSchema,
  createdAt: TimestampSchema,
});
export type Review = z.infer<typeof ReviewSchema>;

/**
 * Decides the item's current version, which must be in `review`. Approving needs a render;
 * requesting changes needs a comment and, unless `enqueueRevision` is false, queues a
 * `content.revise` job with the comment. `enqueueRevision` applies to `request_changes` only.
 */
export const CreateReviewRequestSchema = z
  .object({
    versionId: IdSchema,
    decision: ReviewDecisionSchema,
    comment: z.string().trim().max(REVIEW_COMMENT_MAX_LENGTH).optional(),
    enqueueRevision: z.boolean().optional(),
  })
  .superRefine((review, ctx) => {
    if (review.decision === "request_changes" && !review.comment) {
      ctx.addIssue({
        code: "custom",
        message: "Say what should change",
        path: ["comment"],
      });
    }
    if (review.decision !== "request_changes" && review.enqueueRevision !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Only a request for changes queues a revision",
        path: ["enqueueRevision"],
      });
    }
  });
export type CreateReviewRequest = z.infer<typeof CreateReviewRequestSchema>;

export const CreateReviewResponseSchema = z.object({
  review: ReviewSchema,
  item: ContentItemSchema,
});
export type CreateReviewResponse = z.infer<typeof CreateReviewResponseSchema>;

/** `GET /api/reviews/queue`: items in `review`, by `targetAt` (nulls last), then `updatedAt`. */
export const ReviewQueueQuerySchema = CursorPageQuerySchema.extend({
  projectId: IdSchema.optional(),
});
export type ReviewQueueQuery = z.infer<typeof ReviewQueueQuerySchema>;
