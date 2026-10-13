import { calendarTools } from "@loomcast/contracts";
import type { Database } from "@loomcast/db";
import { listSlots } from "../../calendar/slots";
import type { SeriesService } from "../../series/service";
import { defineTool, McpToolError, type ToolDefinition } from "./registry";

export interface CalendarToolsDeps {
  db: Database;
  series: Pick<SeriesService, "get">;
}

/** `calendar.get_slots`: the cadence slots of series in a range, with the post holding each. */
export function createCalendarTools(deps: CalendarToolsDeps): ToolDefinition[] {
  const { db, series } = deps;

  const getSlots = defineTool(calendarTools["calendar.get_slots"], {
    async resolveProject(input) {
      if (input.projectId !== undefined) {
        return input.projectId;
      }
      if (input.seriesId !== undefined) {
        return (await series.get(input.seriesId))?.projectId ?? null;
      }
      return undefined;
    },
    async handler(input, ctx) {
      const named = input.projectId !== undefined || input.seriesId !== undefined;
      if (named && ctx.projectId === null) {
        throw new McpToolError(
          "not_found",
          input.seriesId === undefined ? "No project has that id." : "No series has that id.",
        );
      }
      const slots = await listSlots(db, {
        from: new Date(input.from),
        to: new Date(input.to),
        ...(ctx.projectId === null ? {} : { projectId: ctx.projectId }),
        ...(input.seriesId === undefined ? {} : { seriesIds: [input.seriesId] }),
        ...(input.channelId === undefined ? {} : { channelIds: [input.channelId] }),
      });
      return { slots };
    },
    summary: ({ slots }) => {
      const open = slots.filter((slot) => slot.postId === undefined).length;
      return `${slots.length} slot${slots.length === 1 ? "" : "s"}, ${open} open.`;
    },
  });

  return [getSlots];
}
