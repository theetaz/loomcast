import { cn } from "@loomcast/ui/lib/cn";
import { CheckIcon } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * A native checkbox drawn in the theme, so forms, labels and keyboards behave as the browser
 * makes them. The tick scales in from 75% with the brand ease-out; reduced motion drops it.
 */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)}>
      <input
        type="checkbox"
        className={cn(
          "peer size-4 cursor-pointer appearance-none rounded-[4px] bg-background outline-none",
          "shadow-[inset_0_0_0_1px_var(--input)] transition-[background-color,box-shadow]",
          "checked:bg-primary checked:shadow-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        {...props}
      />
      <CheckIcon
        aria-hidden="true"
        strokeWidth={3}
        className={cn(
          "pointer-events-none absolute inset-0 m-auto size-3 scale-75 text-primary-foreground opacity-0",
          "transition-[opacity,transform] duration-menu-in ease-out motion-reduce:transition-none",
          "peer-checked:scale-100 peer-checked:opacity-100",
        )}
      />
    </span>
  );
}
