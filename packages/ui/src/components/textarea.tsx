import { cn } from "@loomcast/ui/lib/cn";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content flex min-h-16 w-full rounded-md bg-card px-2.5 py-2 text-[13px] text-foreground leading-normal shadow-card outline-none transition-shadow",
        "placeholder:text-text-4",
        "focus-visible:shadow-focus",
        "aria-invalid:shadow-[0_0_0_1px_var(--destructive)] aria-invalid:focus-visible:shadow-[0_0_0_1px_var(--destructive),0_0_0_4px_color-mix(in_srgb,var(--destructive)_14%,transparent)]",
        "disabled:cursor-not-allowed disabled:bg-secondary disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
