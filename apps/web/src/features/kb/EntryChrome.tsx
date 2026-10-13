import type { KbEntry } from "@loomcast/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@loomcast/ui/components/alert-dialog";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/RelativeTime";
import { api, errorMessage } from "@/lib/api";
import { KIND_META } from "./kinds";
import { removeKbEntry } from "./queries";

const CREATED_VIA: Record<KbEntry["createdVia"], string> = {
  ui: "in Loomcast",
  mcp: "by an MCP client",
  producer: "by a producer session",
  hook: "by the session hook",
};

/** "Back to knowledge", plus the page's actions on the right. */
export function EntryToolbar({
  projectParam,
  children,
}: {
  projectParam: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-7.5 flex-wrap items-center gap-2">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/projects/$projectId/kb" params={{ projectId: projectParam }}>
          <ArrowLeftIcon aria-hidden="true" />
          Knowledge
        </Link>
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** Kind, provenance and age of a stored entry. */
export function EntryMeta({ entry, children }: { entry: KbEntry; children?: ReactNode }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 text-text-2">
        <Icon aria-hidden="true" className={cn("size-3.5", meta.tone)} />
        {meta.label}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        Saved {CREATED_VIA[entry.createdVia]}{" "}
        <RelativeTime value={entry.createdAt} format="relative" />
      </span>
      {entry.updatedAt !== entry.createdAt ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            Updated <RelativeTime value={entry.updatedAt} format="relative" />
          </span>
        </>
      ) : null}
      {children}
    </div>
  );
}

/** Tags as read-only chips. */
export function TagChips({ tags, className }: { tags: readonly string[]; className?: string }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className={cn("flex flex-wrap gap-1.5", className)}>
      {tags.map((tag) => (
        <li
          key={tag}
          className="rounded-full bg-secondary px-2 font-mono text-[11px] text-text-2 leading-6 shadow-[0_0_0_1px_var(--border)]"
        >
          #{tag}
        </li>
      ))}
    </ul>
  );
}

/** Deletes the entry after a confirmation, then returns to the list. */
export function DeleteEntryButton({
  entry,
  projectParam,
}: {
  entry: KbEntry;
  projectParam: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api.request("kb.delete", { params: { id: entry.id } }),
    onSuccess: () => {
      setOpen(false);
      toast.success("Entry deleted", { description: entry.title });
      void navigate({ to: "/projects/$projectId/kb", params: { projectId: projectParam } });
      removeKbEntry(queryClient, entry.id, entry.projectId);
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (remove.isPending) return;
        if (next) remove.reset();
        setOpen(next);
      }}
    >
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Trash2Icon aria-hidden="true" />
        Delete
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="min-w-0 break-words">
            Delete “{entry.title}”?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The entry leaves the knowledge base, and producer sessions stop seeing it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
          >
            {errorMessage(remove.error, "Couldn't delete the entry. Try again.")}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              remove.mutate();
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete entry"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function EntrySkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <Skeleton className="h-7 w-28" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <Skeleton className="min-h-[280px] rounded-lg" />
    </div>
  );
}
