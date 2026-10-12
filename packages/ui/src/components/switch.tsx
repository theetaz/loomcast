import { cn } from "@loomcast/ui/lib/cn";
import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full outline-none transition-[background-color,box-shadow]",
        "data-[size=default]:h-4.5 data-[size=default]:w-7.5 data-[size=sm]:h-3.5 data-[size=sm]:w-6",
        "data-unchecked:bg-accent data-unchecked:shadow-[inset_0_0_0_1px_var(--input)] data-checked:bg-primary",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "aria-invalid:ring-2 aria-invalid:ring-destructive/40 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-menu-in ease-out motion-reduce:transition-none",
          "group-data-[size=default]/switch:size-3.5 group-data-[size=default]/switch:data-checked:translate-x-3.5",
          "group-data-[size=sm]/switch:size-2.5 group-data-[size=sm]/switch:data-checked:translate-x-3",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
