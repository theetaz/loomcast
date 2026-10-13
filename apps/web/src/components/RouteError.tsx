import { Button } from "@loomcast/ui/components/button";
import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { useTitle } from "@/lib/use-title";

/**
 * The error boundary of every route. A failure inside the app keeps the shell
 * around it; retrying reruns the route's loaders and resets the boundary.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useTitle("Something went wrong");

  const retry = async () => {
    await router.invalidate();
    reset();
  };

  return (
    <div
      role="alert"
      className="flex min-h-[calc(100svh-44px)] flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-status-red/11 text-status-red">
        <TriangleAlertIcon aria-hidden="true" className="size-[18px]" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <h1 className="text-title">Something went wrong</h1>
        <p className="text-control text-muted-foreground text-pretty">
          {errorMessage(error, "This page hit an unexpected error. Try again, or go back home.")}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={retry}>
          <RotateCwIcon aria-hidden="true" />
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link to="/">Back to home</Link>
        </Button>
      </div>
    </div>
  );
}
