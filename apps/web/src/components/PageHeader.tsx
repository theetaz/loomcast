import { cn } from "@loomcast/ui/lib/cn";
import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Page title, one line of context and the page's actions; actions wrap below on phones. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-title text-foreground break-words">{title}</h1>
        {description ? (
          <div className="text-control text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

/** The scrolling content column every page sits in. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-4 pt-5 pb-10 md:px-6 md:pt-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
