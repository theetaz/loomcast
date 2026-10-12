import { cn } from "@loomcast/ui/lib/cn";
import { Avatar as AvatarPrimitive } from "radix-ui";
import type * as React from "react";

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg";
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative flex size-7 shrink-0 select-none rounded-full data-[size=lg]:size-9 data-[size=sm]:size-5",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:shadow-[inset_0_0_0_1px_rgb(28_25_20/0.08)] dark:after:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]",
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full rounded-full object-cover", className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-accent font-medium text-[11px] text-text-2 group-data-[size=lg]/avatar:text-control group-data-[size=sm]/avatar:text-[9px]",
        className,
      )}
      {...props}
    />
  );
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex select-none items-center justify-center rounded-full bg-status-green text-white ring-2 ring-background",
        "group-data-[size=sm]/avatar:size-1.5 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2 group-data-[size=default]/avatar:[&>svg]:size-1.5",
        "group-data-[size=lg]/avatar:size-2.5 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-1.5 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-full bg-accent font-medium text-[11px] text-text-2 ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-9 group-has-data-[size=sm]/avatar-group:size-5 [&>svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage };
