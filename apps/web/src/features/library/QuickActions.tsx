import { allowedActions, type ContentItem } from "@loomcast/contracts";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, EllipsisIcon, ExternalLinkIcon, WandSparklesIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useMe } from "@/features/auth/queries";
import { errorMessage } from "@/lib/api";
import { useArchiveItem, useProduceThroughReview } from "./queries";

/**
 * The quick actions of one item: produce it through review, open it, or archive it after a
 * confirmation. What is enabled follows the contracts' `allowedActions`.
 */
export function QuickActions({ item }: { item: ContentItem }) {
  const me = useMe();
  const navigate = useNavigate();
  const produce = useProduceThroughReview();
  const archive = useArchiveItem();
  const [confirming, setConfirming] = useState(false);
  // Listed items carry no artifacts; producing and archiving need none.
  const allowed = allowedActions(item.state, "user", me.role, null);
  const canProduce = allowed.includes("produce");
  const canArchive = allowed.includes("archive");

  const startProduction = () =>
    produce.mutate(item, {
      onSuccess: () =>
        toast.success("Production started", {
          description: `${item.title} moves to review once it is rendered.`,
        }),
      onError: (error) =>
        toast.error("Couldn't start production", {
          description: errorMessage(error, "Try again in a moment."),
        }),
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${item.title}`}>
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem disabled={!canProduce || produce.isPending} onSelect={startProduction}>
            <WandSparklesIcon aria-hidden="true" />
            Produce through review
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void navigate({ to: "/content/$itemId", params: { itemId: item.id } })}
          >
            <ExternalLinkIcon aria-hidden="true" />
            Open
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!canArchive}
            onSelect={() => {
              archive.reset();
              setConfirming(true);
            }}
          >
            <ArchiveIcon aria-hidden="true" />
            Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!archive.isPending) setConfirming(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="min-w-0 break-words">
              Archive {item.title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the pipeline and the library hides it. You can restore it later as an idea.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {archive.isError ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
            >
              {errorMessage(archive.error, "Couldn't archive it. Try again.")}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archive.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={archive.isPending}
              onClick={(event) => {
                // Stay open until the request settles.
                event.preventDefault();
                archive.mutate(item, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success("Archived", { description: item.title });
                  },
                });
              }}
            >
              {archive.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
