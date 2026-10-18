import type { ContentItem, ContentVersion } from "@loomcast/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@loomcast/ui/components/dialog";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { toast } from "sonner";
import { ScheduleForm } from "./ScheduleForm";

/**
 * Schedules an item on channels that publish its format: an approved one, or one ready for or in
 * review, which is approved on the way.
 */
export function ScheduleDialog({
  open,
  item,
  version,
  onClose,
}: {
  open: boolean;
  item: ContentItem;
  version: ContentVersion;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="break-words">Schedule “{item.title}”</DialogTitle>
          <DialogDescription>
            {item.state === "render" || item.state === "review"
              ? "It's approved and scheduled on every channel you pick, at the same time."
              : "It's scheduled on every channel you pick, at the same time."}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ScrollArea className="min-h-0 flex-1" viewportClassName="max-h-[70dvh] pr-1">
            <ScheduleForm
              key={version.id}
              item={item}
              versionId={version.id}
              media={version.media}
              defaults={{ title: item.format === "video" ? item.title : "" }}
              onCancel={onClose}
              onDone={(posts) => {
                toast.success(`Scheduled “${item.title}”`, {
                  description:
                    posts.length === 1 ? "On 1 channel." : `On ${posts.length} channels.`,
                });
                onClose();
              }}
            />
          </ScrollArea>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
