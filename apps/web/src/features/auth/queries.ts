import type { LoginRequest, Me } from "@loomcast/contracts";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** The signed-in user. A 401 is the guard's to handle, so it never triggers the global redirect. */
export function meQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.request("auth.me", { signal, redirectOnUnauthorized: false }),
    staleTime: 5 * 60_000,
  });
}

/** Only for components under the `_app` guard, which has already loaded the user. */
export function useMe(): Me {
  return useSuspenseQuery(meQueryOptions()).data;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.request("auth.login", { body }),
    onSuccess: (me) => {
      // Start clean: nothing cached for a previous session survives a sign-in.
      queryClient.clear();
      queryClient.setQueryData(queryKeys.me, me);
    },
  });
}

/**
 * Ends the session, leaves the app and only then drops the cache, so mounted
 * screens never refetch without a session on the way out. A failed request
 * still signs out locally: the cookie is useless to the user either way.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.request("auth.logout", { redirectOnUnauthorized: false }),
    onSettled: async () => {
      await navigate({ to: "/login", replace: true });
      queryClient.clear();
    },
  });
}
