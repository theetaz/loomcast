import { cn } from "@loomcast/ui/lib/cn";
import type * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md bg-card px-2.5 text-[13px] text-foreground shadow-card outline-none transition-shadow",
        "placeholder:text-text-4 selection:bg-primary selection:text-primary-foreground",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:font-medium file:text-control file:text-foreground",
        "focus-visible:shadow-focus",
        "aria-invalid:shadow-[0_0_0_1px_var(--destructive)] aria-invalid:focus-visible:shadow-[0_0_0_1px_var(--destructive),0_0_0_4px_color-mix(in_srgb,var(--destructive)_14%,transparent)]",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-secondary disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
