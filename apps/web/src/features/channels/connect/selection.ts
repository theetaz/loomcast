import type { CandidateAccount } from "@loomcast/contracts";

// Choosing accounts of a sign-in. An account with a `parentId` (an Instagram account) publishes
// through its parent (the Facebook Page), so choosing it chooses the parent too, and dropping the
// parent drops it.

/** The accounts with each parent followed by its children, otherwise in the server's order. */
export function orderCandidates<T extends Pick<CandidateAccount, "id" | "parentId">>(
  accounts: readonly T[],
): T[] {
  const ids = new Set(accounts.map((account) => account.id));
  const roots = accounts.filter(
    (account) => account.parentId === null || !ids.has(account.parentId),
  );
  return roots.flatMap((root) => [
    root,
    ...accounts.filter((account) => account.parentId === root.id && account !== root),
  ]);
}

/** `selected` with `id` switched to `checked`, keeping parents and children consistent. */
export function toggleCandidate(
  accounts: readonly Pick<CandidateAccount, "id" | "parentId">[],
  selected: ReadonlySet<string>,
  id: string,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  if (checked) {
    let current = byId.get(id);
    while (current && !next.has(current.id)) {
      next.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return next;
  }
  const drop = (target: string) => {
    next.delete(target);
    for (const account of accounts) {
      if (account.parentId === target && next.has(account.id)) drop(account.id);
    }
  };
  drop(id);
  return next;
}
