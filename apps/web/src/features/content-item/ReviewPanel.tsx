import { type ContentItem, REVIEW_COMMENT_MAX_LENGTH, type Review } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Label } from "@loomcast/ui/components/label";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { CheckIcon, MessageSquareWarningIcon, ThumbsDownIcon } from "lucide-react";
import { type Ref, useId, useState } from "react";
import { RelativeTime } from "@/components/RelativeTime";
import type { ItemDecisions } from "./decisions";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const DECISION_LABELS: Record<Review["decision"], string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  reject: "Rejected",
};

/** Why Approve is off while the item waits in review. */
function approveHint(item: ContentItem, decisions: ItemDecisions): string | null {
  if (decisions.can("approve")) return decisions.hasActiveJob ? "A job is still running." : null;
  if (item.state !== "review") return null;
  return "Approving needs a rendered video.";
}

/**
 * The review of the current version: Approve (only when allowed), Request changes with a comment
 * and the option to have the producer revise (⌘Enter sends), and Reject after a confirmation.
 * There are no single-key shortcuts. Earlier decisions are listed below.
 */
export function ReviewPanel({
  item,
  versionNo,
  decisions,
  reviews,
  commentRef,
}: {
  item: ContentItem;
  versionNo: number;
  decisions: ItemDecisions;
  reviews: readonly Review[];
  commentRef: Ref<HTMLTextAreaElement>;
}) {
  const [comment, setComment] = useState("");
  const [revise, setRevise] = useState(true);
  const [missing, setMissing] = useState(false);
  const ids = { comment: useId(), revise: useId(), hint: useId(), error: useId() };
  const inReview = item.state === "review";
  const canRequest = decisions.can("request_changes");
  const hint = approveHint(item, decisions);

  const submitChanges = () => {
    if (!canRequest || decisions.busy) return;
    const text = comment.trim();
    if (!text) {
      setMissing(true);
      return;
    }
    setMissing(false);
    decisions.requestChanges(text, revise, () => setComment(""));
  };

  if (!inReview && reviews.length === 0) return null;

  return (
    <section aria-labelledby="review-heading" className="rounded-lg bg-card shadow-card">
      <div className="flex h-11 items-center border-divider border-b px-4">
        <h2 id="review-heading" className="font-semibold text-[13px]">
          Review
        </h2>
        {inReview ? (
          <span className="ml-auto text-small text-muted-foreground">Deciding v{versionNo}</span>
        ) : null}
      </div>
      {inReview ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              className="w-full"
              disabled={!decisions.can("approve") || decisions.busy || decisions.hasActiveJob}
              aria-describedby={hint ? ids.hint : undefined}
              onClick={decisions.approve}
            >
              <CheckIcon aria-hidden="true" />
              Approve
            </Button>
            {hint ? (
              <p id={ids.hint} className="text-small text-text-4">
                {hint}
              </p>
            ) : null}
          </div>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitChanges();
            }}
          >
            <Label htmlFor={ids.comment}>What should change?</Label>
            <Textarea
              ref={commentRef}
              id={ids.comment}
              value={comment}
              rows={3}
              maxLength={REVIEW_COMMENT_MAX_LENGTH}
              disabled={!canRequest}
              placeholder="The hook runs long. Open on the error message."
              aria-invalid={missing || undefined}
              aria-describedby={missing ? ids.error : undefined}
              onChange={(event) => {
                setComment(event.target.value);
                if (missing && event.target.value.trim()) setMissing(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submitChanges();
                }
              }}
            />
            {missing ? (
              <p id={ids.error} role="alert" className="text-small text-destructive">
                Say what should change.
              </p>
            ) : null}
            <label htmlFor={ids.revise} className="flex items-center gap-2 text-control">
              <input
                id={ids.revise}
                type="checkbox"
                checked={revise}
                disabled={!canRequest}
                onChange={(event) => setRevise(event.target.checked)}
                className="size-3.5 rounded-sm accent-primary"
              />
              Ask the producer to revise
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!canRequest || decisions.busy}
              >
                <MessageSquareWarningIcon aria-hidden="true" />
                Request changes
              </Button>
              <span className="text-small text-text-4">{isMac ? "⌘Enter" : "Ctrl+Enter"}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                disabled={!decisions.can("reject") || decisions.busy || decisions.hasActiveJob}
                onClick={decisions.confirmReject}
              >
                <ThumbsDownIcon aria-hidden="true" />
                Reject
              </Button>
            </div>
          </form>
        </div>
      ) : null}
      {reviews.length > 0 ? (
        <ol
          aria-label="Earlier decisions"
          className={cn("flex flex-col px-4 py-2", inReview && "border-divider border-t")}
        >
          {reviews.map((review) => (
            <li key={review.id} className="flex flex-col gap-0.5 py-1.5">
              <p className="text-small">
                <span
                  className={cn(
                    "font-medium",
                    review.decision === "approve" && "text-status-green",
                    review.decision === "request_changes" && "text-status-amber",
                    review.decision === "reject" && "text-status-red",
                  )}
                >
                  {DECISION_LABELS[review.decision]}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · <RelativeTime value={review.createdAt} format="relative" />
                  {review.enqueueRevision ? " · revision queued" : ""}
                </span>
              </p>
              {review.comment ? (
                <p className="whitespace-pre-wrap break-words text-small text-text-2">
                  {review.comment}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
