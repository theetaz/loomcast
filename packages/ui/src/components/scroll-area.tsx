import { cn } from "@loomcast/ui/lib/cn";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import type * as React from "react";

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** Which scrollbars to draw. Content only scrolls along the axes listed here. */
  orientation?: "vertical" | "horizontal" | "both";
  /** Classes for the scrolling viewport. Put max-height and padding here, not on the root. */
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportProps?: Omit<
    React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>,
    "className" | "ref"
  >;
};

function ScrollArea({
  className,
  children,
  orientation = "vertical",
  viewportClassName,
  viewportRef,
  viewportProps,
  style,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      // A column flex box, so the viewport also fills a parent that only has a max-height.
      className={cn("relative flex flex-col overflow-hidden", className)}
      // The primitive sets an inline `position: relative`; leave position to the
      // class names, so an area can be placed with `absolute inset-0`.
      style={{ position: undefined, ...style }}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "min-h-0 w-full flex-1 rounded-[inherit] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          // The primitive wraps content in a `display: table` div, which stops
          // text from truncating. Vertical-only areas lay it out as a block.
          orientation === "vertical" && "[&>div]:block!",
          viewportClassName,
        )}
        {...viewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" && <ScrollBar />}
      {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-0.5 data-horizontal:h-2.5 data-vertical:h-full data-vertical:w-2.5 data-horizontal:flex-col",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-input transition-colors hover:bg-text-4"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
