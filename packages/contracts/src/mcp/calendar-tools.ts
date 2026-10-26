import { z } from "zod";
import { CalendarSlotSchema, checkCalendarRange } from "../api/calendar";
import { IdSchema, TimestampSchema } from "../common";
import type { McpToolContract } from "./contract";

/**
 * Cadence slots in `[from, to)`, at most 62 days. `seriesId` and `channelId` narrow the result;
 * `workspaceId` keeps it to one workspace. A job token always sees only its job's workspace.
 */
export const CalendarGetSlotsInputSchema = z
  .object({
    workspaceId: IdSchema.optional(),
    seriesId: IdSchema.optional(),
    channelId: IdSchema.optional(),
    from: TimestampSchema,
    to: TimestampSchema,
  })
  .superRefine(checkCalendarRange);
export type CalendarGetSlotsInput = z.infer<typeof CalendarGetSlotsInputSchema>;

/** Slots in time order. `postId` is set when a post holds the slot. */
export const CalendarGetSlotsOutputSchema = z.object({
  slots: z.array(CalendarSlotSchema),
});
export type CalendarGetSlotsOutput = z.infer<typeof CalendarGetSlotsOutputSchema>;

/** The calendar tools served on `/mcp`. Producer sessions may read slots with their job token. */
export const calendarTools = {
  "calendar.get_slots": {
    name: "calendar.get_slots",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "input",
    description:
      "List the publishing slots of series' cadences between two times (at most 62 days), per channel, with the post that holds each slot if any.",
    input: CalendarGetSlotsInputSchema,
    output: CalendarGetSlotsOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;

export type CalendarToolName = keyof typeof calendarTools;
