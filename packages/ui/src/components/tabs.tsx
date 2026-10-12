import { cn } from "@loomcast/ui/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list relative inline-flex w-fit items-center justify-center text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  {
    variants: {
      variant: {
        default:
          "rounded-[8px] bg-secondary p-0.5 shadow-[0_0_0_1px_var(--border)] group-data-horizontal/tabs:h-7",
        line: "gap-1 group-data-horizontal/tabs:h-8",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/**
 * Slides one indicator under the active trigger in 220ms on the brand ease-out
 * curve. Changes made from the keyboard, the first placement and resizes jump
 * without animating. Writes styles straight to the indicator element so no
 * React render or inherited variable recalculation happens per change.
 */
function useActiveTabIndicator(
  listRef: React.RefObject<HTMLDivElement | null>,
  indicatorRef: React.RefObject<HTMLSpanElement | null>,
  enabled: boolean,
) {
  React.useLayoutEffect(() => {
    const list = listRef.current;
    const indicator = indicatorRef.current;
    if (!enabled || !list || !indicator) return;

    let fromKeyboard = false;

    const place = (animate: boolean) => {
      const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (!active) {
        delete indicator.dataset.ready;
        return;
      }
      if (!animate) indicator.style.transition = "none";
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.height = `${active.offsetHeight}px`;
      indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
      indicator.dataset.ready = "";
      if (!animate) {
        // Flush the jump while transitions are off, then restore them.
        void indicator.offsetWidth;
        indicator.style.transition = "";
      }
    };

    const onKeyDown = () => {
      fromKeyboard = true;
    };
    const onPointerDown = () => {
      fromKeyboard = false;
    };

    place(false);
    list.addEventListener("keydown", onKeyDown);
    list.addEventListener("pointerdown", onPointerDown);

    const mutations = new MutationObserver(() => place(!fromKeyboard));
    mutations.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-state"] });

    const resizes =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place(false));
    resizes?.observe(list);

    return () => {
      list.removeEventListener("keydown", onKeyDown);
      list.removeEventListener("pointerdown", onPointerDown);
      mutations.disconnect();
      resizes?.disconnect();
    };
  }, [listRef, indicatorRef, enabled]);
}

function TabsList({
  className,
  variant = "default",
  children,
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const indicatorRef = React.useRef<HTMLSpanElement>(null);
  const withIndicator = variant !== "line";
  useActiveTabIndicator(listRef, indicatorRef, withIndicator);

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  return (
    <TabsPrimitive.List
      ref={setRefs}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {withIndicator && (
        <span
          ref={indicatorRef}
          aria-hidden="true"
          data-slot="tabs-indicator"
          className="pointer-events-none absolute top-0 left-0 rounded-[6px] bg-card opacity-0 shadow-[0_1px_2px_rgb(0_0_0/0.08)] transition-[transform,width,height] duration-tabs ease-out data-ready:opacity-100 motion-reduce:transition-none dark:shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 items-center justify-center gap-[5px] whitespace-nowrap rounded-[6px] px-[9px] font-medium text-small text-muted-foreground outline-none transition-colors duration-tabs ease-out",
        "hover:text-foreground data-active:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:py-1",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity after:duration-tabs group-data-horizontal/tabs:after:inset-x-1 group-data-horizontal/tabs:after:-bottom-1 group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-body outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
