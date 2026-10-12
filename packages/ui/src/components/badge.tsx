import { cn } from "@loomcast/ui/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

const badgeVariants = cva(
  [
    "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full px-2 font-medium text-[11.5px] transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  ],
  {
    variants: {
      variant: {
        default: "bg-accent-soft text-primary [a]:hover:bg-primary/16",
        secondary:
          "bg-secondary text-muted-foreground shadow-[0_0_0_1px_var(--border)] [a]:hover:text-foreground",
        destructive: "bg-destructive/11 text-destructive [a]:hover:bg-destructive/18",
        outline:
          "text-text-2 shadow-[0_0_0_1px_var(--border)] [a]:hover:bg-foreground/5 [a]:hover:text-foreground",
        ghost: "text-text-2 hover:bg-foreground/5 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
