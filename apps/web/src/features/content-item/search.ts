import { IdSchema } from "@loomcast/contracts";
import { z } from "zod";

// Kept apart from the page: route options load with the app, the page loads on demand.

export const ITEM_TABS = ["script", "storyboard", "voice", "video"] as const;
export type ItemTab = (typeof ITEM_TABS)[number];

/**
 * The item page's address: the open tab, a version other than the current one, and a version to
 * compare the script with. Invalid values are dropped, not fatal.
 */
export const ItemSearchSchema = z.object({
  tab: z.enum(ITEM_TABS).optional().catch(undefined),
  version: IdSchema.optional().catch(undefined),
  compare: IdSchema.optional().catch(undefined),
});
export type ItemSearch = z.infer<typeof ItemSearchSchema>;
