import type { PublishMode } from "../enums";

/**
 * The publish mode of one post: the series' format mode, unless the channel requires approval.
 *
 * | Format mode | Channel requires approval | Post |
 * |---|---|---|
 * | `auto` | no | `auto` |
 * | `auto` | yes | `approval` |
 * | `approval` | no | `approval` |
 * | `approval` | yes | `approval` |
 *
 * An item is approved by the system only when every one of its open posts is `auto`.
 */
export function effectivePublishMode(
  formatMode: PublishMode,
  requiresApproval: boolean,
): PublishMode {
  return requiresApproval ? "approval" : formatMode;
}
