import {
  ACTIVE_COMPETITOR_SCAN_STATUSES,
  type Competitor,
  type CompetitorScan,
  type CompetitorScanStatus,
  type CreateCompetitorRequest,
  type CreateCompetitorScanRequest,
  type List,
} from "@loomcast/contracts";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SCAN_POLL_MS } from "./polling";

/** Competitor query keys. Mutations patch the same caches. */
export const competitorKeys = {
  all: ["competitors"] as const,
  list: (workspaceId: string) => ["competitors", "list", workspaceId] as const,
  detail: (id: string) => ["competitors", "detail", id] as const,
  scans: (competitorId: string) => ["competitors", "scans", competitorId] as const,
  scan: (scanId: string) => ["competitors", "scan", scanId] as const,
};

/** Whether a scan still has work on its way. */
export function isActiveScan(status: CompetitorScanStatus): boolean {
  return (ACTIVE_COMPETITOR_SCAN_STATUSES as readonly CompetitorScanStatus[]).includes(status);
}

/** How often to refetch: every few seconds while something is active, never otherwise. */
export function pollWhile(active: boolean): number | false {
  return active ? SCAN_POLL_MS : false;
}

export function competitorsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: competitorKeys.list(workspaceId),
    queryFn: ({ signal }) => api.request("competitors.list", { params: { workspaceId }, signal }),
    refetchInterval: (query) =>
      pollWhile(
        (query.state.data?.items ?? []).some(
          (competitor) => competitor.latestScan && isActiveScan(competitor.latestScan.status),
        ),
      ),
  });
}

export function competitorQueryOptions(id: string) {
  return queryOptions({
    queryKey: competitorKeys.detail(id),
    queryFn: ({ signal }) => api.request("competitors.get", { params: { id }, signal }),
  });
}

export function competitorScansQueryOptions(competitorId: string) {
  return queryOptions({
    queryKey: competitorKeys.scans(competitorId),
    queryFn: ({ signal }) =>
      api.request("competitors.scans", { params: { id: competitorId }, signal }),
    refetchInterval: (query) =>
      pollWhile((query.state.data?.items ?? []).some((scan) => isActiveScan(scan.status))),
  });
}

export function competitorScanQueryOptions(scanId: string) {
  return queryOptions({
    queryKey: competitorKeys.scan(scanId),
    queryFn: ({ signal }) => api.request("competitorScans.get", { params: { id: scanId }, signal }),
    refetchInterval: (query) =>
      pollWhile(query.state.data ? isActiveScan(query.state.data.status) : false),
  });
}

/** Stores a competitor the API returned, in its detail and its workspace's list. */
export function cacheCompetitor(queryClient: QueryClient, competitor: Competitor) {
  queryClient.setQueryData(competitorKeys.detail(competitor.id), competitor);
  queryClient.setQueryData<List<Competitor>>(
    competitorKeys.list(competitor.workspaceId),
    (list) => {
      if (!list) return list;
      const present = list.items.some((item) => item.id === competitor.id);
      return {
        items: present
          ? list.items.map((item) => (item.id === competitor.id ? competitor : item))
          : [competitor, ...list.items],
      };
    },
  );
}

/** Stores a scan the API returned, and refetches what shows its summary. */
export function cacheScan(queryClient: QueryClient, scan: CompetitorScan) {
  queryClient.setQueryData(competitorKeys.scan(scan.id), scan);
  queryClient.setQueryData<List<CompetitorScan>>(
    competitorKeys.scans(scan.competitorId),
    (list) => {
      if (!list) return list;
      const present = list.items.some((item) => item.id === scan.id);
      return {
        items: present
          ? list.items.map((item) => (item.id === scan.id ? scan : item))
          : [scan, ...list.items],
      };
    },
  );
  void queryClient.invalidateQueries({ queryKey: competitorKeys.detail(scan.competitorId) });
  void queryClient.invalidateQueries({ queryKey: competitorKeys.list(scan.workspaceId) });
}

export function useCreateCompetitor(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCompetitorRequest) =>
      api.request("competitors.create", { params: { workspaceId }, body }),
    onSuccess: (competitor) => cacheCompetitor(queryClient, competitor),
  });
}

export function useUpdateCompetitorNotes(competitorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notes: string | null) =>
      api.request("competitors.update", { params: { id: competitorId }, body: { notes } }),
    onSuccess: (competitor) => cacheCompetitor(queryClient, competitor),
  });
}

export function useDeleteCompetitor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (competitor: Competitor) =>
      api.request("competitors.delete", { params: { id: competitor.id } }),
    onSuccess: (_data, competitor) => {
      queryClient.setQueryData<List<Competitor>>(
        competitorKeys.list(competitor.workspaceId),
        (list) => (list ? { items: list.items.filter((item) => item.id !== competitor.id) } : list),
      );
      queryClient.removeQueries({ queryKey: competitorKeys.detail(competitor.id) });
      queryClient.removeQueries({ queryKey: competitorKeys.scans(competitor.id) });
    },
  });
}

export function useStartScan(competitorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCompetitorScanRequest) =>
      api.request("competitors.scan", { params: { id: competitorId }, body }),
    onSuccess: (scan) => cacheScan(queryClient, scan),
  });
}

export function useCancelScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scan: CompetitorScan) =>
      api.request("competitorScans.cancel", { params: { id: scan.id } }),
    onSuccess: (scan) => cacheScan(queryClient, scan),
  });
}
