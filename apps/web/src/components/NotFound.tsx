import { LoomcastMark } from "@loomcast/ui/brand";
import { Button } from "@loomcast/ui/components/button";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useTitle } from "@/lib/use-title";

/** The 404 page. Inside the app shell it fills the content area; on its own, the screen. */
export function NotFound() {
  useTitle("Page not found");
  return (
    <div className="flex min-h-[calc(100svh-44px)] flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <LoomcastMark size={36} aria-hidden="true" />
      <div className="flex max-w-sm flex-col gap-1.5">
        <p className="font-mono text-mono text-muted-foreground">404</p>
        <h1 className="text-title">This page doesn't exist</h1>
        <p className="text-control text-muted-foreground text-pretty">
          The link may be old, or the page may have moved. Check the address or head back home.
        </p>
      </div>
      <Button asChild variant="outline">
        <Link to="/">
          <ArrowLeftIcon aria-hidden="true" />
          Back to home
        </Link>
      </Button>
    </div>
  );
}
