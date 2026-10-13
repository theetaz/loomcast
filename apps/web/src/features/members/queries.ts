import type { InviteUserRequest, List, UserSummary } from "@loomcast/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

export type MemberStatus = "active" | "pending" | "disabled";

/**
 * Disabled users can't sign in. Everyone else is active once they have signed
 * in, and pending until then (an invitation or reset link not used yet).
 */
export function memberStatus(user: UserSummary): MemberStatus {
  if (user.disabledAt) return "disabled";
  return user.lastLoginAt ? "active" : "pending";
}

/** The owner first, then people who can sign in by name, disabled users last. */
export function sortMembers(users: readonly UserSummary[]): UserSummary[] {
  const rank = (user: UserSummary) => (user.role === "owner" ? 0 : user.disabledAt ? 2 : 1);
  return [...users].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      a.email.localeCompare(b.email),
  );
}

/** Owner only: the API answers 403 to admins. */
export function membersQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api.request("users.list", { signal }),
    select: (list: List<UserSummary>) => sortMembers(list.items),
  });
}

function useUpsertMember() {
  const queryClient = useQueryClient();
  return (user: UserSummary) => {
    queryClient.setQueryData<List<UserSummary>>(queryKeys.users, (list) =>
      list ? { items: [...list.items.filter((item) => item.id !== user.id), user] } : list,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.users });
  };
}

/**
 * Invites a member. The response carries a one-time set-password link, so the
 * mutation is never kept once the dialog stops observing it (`gcTime: 0`) and
 * only the link-free user goes into the list cache.
 */
export function useInviteMember() {
  const upsert = useUpsertMember();
  return useMutation({
    mutationFn: (body: InviteUserRequest) => api.request("users.invite", { body }),
    gcTime: 0,
    onSuccess: ({ user }) => upsert(user),
  });
}

/** A new set-password link for a member; the previous link stops working. Never cached. */
export function useResetLink() {
  const upsert = useUpsertMember();
  return useMutation({
    mutationFn: (user: UserSummary) => api.request("users.resetLink", { params: { id: user.id } }),
    gcTime: 0,
    onSuccess: ({ user }) => upsert(user),
  });
}

export function useDisableMember() {
  const upsert = useUpsertMember();
  return useMutation({
    mutationFn: (user: UserSummary) => api.request("users.disable", { params: { id: user.id } }),
    onSuccess: (user) => upsert(user),
  });
}
