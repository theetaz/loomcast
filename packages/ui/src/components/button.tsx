import { cn } from "@loomcast/ui/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

const buttonVariants = cva(
  [
    "group/button pressable inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-control outline-none select-none",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "aria-invalid:ring-2 aria-invalid:ring-destructive/40",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.12)] hover:bg-[color-mix(in_srgb,var(--primary)_88%,var(--foreground))]",
        outline:
          "bg-card text-foreground shadow-card hover:bg-secondary aria-expanded:bg-secondary",
        secondary: "bg-accent text-accent-foreground hover:bg-secondary aria-expanded:bg-secondary",
        ghost:
          "text-text-2 hover:bg-foreground/6 hover:text-foreground aria-expanded:bg-foreground/6 aria-expanded:text-foreground",
        destructive:
          "bg-destructive/12 text-destructive hover:bg-destructive/18 focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-7.5 px-[11px] has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-sm px-2 text-[11.5px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-6.5 gap-1 px-[9px] text-small has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-9 gap-2 px-3.5 text-body [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7.5",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-6.5",
        "icon-lg": "size-9 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    compoundVariants: [
      {
        variant: "ghost",
        size: ["icon", "icon-xs", "icon-sm", "icon-lg"],
        className: "text-muted-foreground",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
