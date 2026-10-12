import type { Device, List } from "@loomcast/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** Paired devices that have not been revoked. `device.status` events keep them current. */
export function devicesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.devices,
    queryFn: ({ signal }) => api.request("devices.list", { signal }),
    select: (list: List<Device>) => list.items.filter((device) => device.revokedAt === null),
  });
}

export type StudioState = "online" | "offline" | "unpaired";

export interface StudioSummary {
  state: StudioState;
  online: number;
  total: number;
}

/** The studio is online when any paired device has a live bridge connection. */
export function summarizeStudio(devices: readonly Device[]): StudioSummary {
  const online = devices.filter((device) => device.online).length;
  const state: StudioState = online > 0 ? "online" : devices.length > 0 ? "offline" : "unpaired";
  return { state, online, total: devices.length };
}

export const STUDIO_LABELS: Record<StudioState, string> = {
  online: "Studio online",
  offline: "Studio offline",
  unpaired: "No studio",
};

export function describeStudio({ state, online, total }: StudioSummary): string {
  if (state === "unpaired") return "No studio agent is paired yet.";
  if (state === "offline") {
    return total === 1
      ? "The paired studio agent is offline. Jobs wait until it reconnects."
      : `None of the ${total} paired studio agents are online. Jobs wait until one reconnects.`;
  }
  return total === 1
    ? "The studio agent is connected and ready for jobs."
    : `${online} of ${total} studio agents are connected.`;
}
