import type { ContentItemDetail, ContentVersion, FormatRules } from "@loomcast/contracts";
import type { ItemDecisions } from "./decisions";

/** What every tab of the item page gets. */
export interface ItemTabProps {
  detail: ContentItemDetail;
  /** The version on show: the current one, or an earlier one picked in the timeline. */
  version: ContentVersion;
  viewingCurrent: boolean;
  /** Whether a new version can be written now: allowed, on the current version, no job running. */
  canEdit: boolean;
  /** Why `canEdit` is false, for a hint; null when editing is open. */
  editBlocked: string | null;
  decisions: ItemDecisions;
  /** The format's rules, for targets; null until known or without a series. */
  rules: FormatRules | null;
}
