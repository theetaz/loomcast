import { cn } from "@loomcast/ui/lib/cn";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";

/*
 * A command menu built on cmdk. Nothing here animates: the menu is opened and
 * driven from the keyboard many times a day, so it appears, highlights and
 * leaves instantly. Items highlight like menu items, without a transition.
 */

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

export interface CommandDialogProps
  extends Omit<React.ComponentProps<typeof DialogPrimitive.Root>, "children"> {
  /** Accessible name of the dialog; not shown. */
  title?: string;
  /** Accessible description of the dialog; not shown. */
  description?: string;
  className?: string;
  /** Props for the `Command` root, such as `shouldFilter`, `loop` or `label`. */
  commandProps?: Omit<React.ComponentProps<typeof CommandPrimitive>, "children">;
  children: React.ReactNode;
}

/**
 * The command menu in a modal dialog near the top of the screen. It opens and
 * closes without any enter or exit animation.
 */
function CommandDialog({
  title = "Command menu",
  description = "Search for a page or an action.",
  className,
  commandProps,
  children,
  ...props
}: CommandDialogProps) {
  return (
    <DialogPrimitive.Root data-slot="command-dialog" {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="command-dialog-overlay"
          className="fixed inset-0 isolate z-50 bg-[rgb(28_25_20/0.18)] dark:bg-black/50"
        />
        <DialogPrimitive.Content
          data-slot="command-dialog-content"
          className={cn(
            "fixed top-[12vh] left-1/2 z-50 flex max-h-[min(76vh,520px)] w-[calc(100%-1.5rem)] max-w-[600px] -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-pop outline-none max-sm:top-3",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {description}
          </DialogPrimitive.Description>
          <Command {...commandProps} className={cn("min-h-0 flex-1", commandProps?.className)}>
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-12 shrink-0 items-center gap-2.5 border-divider border-b px-3.5"
    >
      <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-text-4" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          // 16px on touch screens so iOS does not zoom into the field.
          "h-full w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none placeholder:text-text-4 disabled:cursor-not-allowed disabled:opacity-50 sm:text-[14px]",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "min-h-0 flex-1 scroll-py-1.5 overflow-y-auto overflow-x-hidden overscroll-contain",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("px-4 py-8 text-center text-control text-muted-foreground", className)}
      {...props}
    />
  );
}

function CommandLoading({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Loading>) {
  return (
    <CommandPrimitive.Loading
      data-slot="command-loading"
      className={cn("px-3.5 py-2 text-small text-muted-foreground", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden px-1.5 pb-1.5 text-foreground first:pt-1.5",
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:text-text-4",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("h-px bg-divider", className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-body text-text-2 outline-hidden",
        "data-[selected=true]:bg-foreground/6 data-[selected=true]:text-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-text-4 data-[selected=true]:[&_svg]:text-text-2 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto pl-3 font-mono text-[10.5px] text-text-4", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
  CommandSeparator,
  CommandShortcut,
};
