import { LoomcastMark } from "@loomcast/ui/brand";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { LoginForm } from "@/features/auth/LoginForm";
import { meQueryOptions } from "@/features/auth/queries";
import { safeNextPath } from "@/features/auth/redirect";
import { useTitle } from "@/lib/use-title";

const loginSearchSchema = z.object({
  next: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchSchema,
  beforeLoad: async ({ context, search }) => {
    // Already signed in: skip the form. Always ask the server, never the cache.
    const me = await context.queryClient
      .fetchQuery({ ...meQueryOptions(), staleTime: 0 })
      .catch(() => null);
    if (me) throw redirect({ href: safeNextPath(search.next), replace: true });
  },
  component: LoginPage,
});

function LoginPage() {
  useTitle("Sign in");
  const router = useRouter();
  const { next } = Route.useSearch();

  const onSuccess = () => router.history.replace(safeNextPath(next));

  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10">
      <div className="flex w-full max-w-[360px] flex-col gap-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <LoomcastMark size={40} aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Sign in to Loomcast</h1>
            <p className="text-control text-muted-foreground">
              Script, render and publish short videos.
            </p>
          </div>
        </div>
        <div className="rounded-xl bg-card p-5 shadow-card sm:p-6">
          <LoginForm onSuccess={onSuccess} />
        </div>
        <p className="text-center text-small text-muted-foreground text-pretty">
          Loomcast is invite only. Ask your workspace owner for an account.
        </p>
      </div>
    </main>
  );
}
