import { cn } from "@loomcast/ui/lib/cn";
import type { ReactNode } from "react";
import { type CellTarget, targetId } from "./time";

/** A week cell or a month day. Cells in the past are shaded. */
export function DropCell({
  target,
  disabled,
  className,
  children,
}: {
  target: CellTarget;
  label: string;
  disabled: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-cell={targetId(target)}
      className={cn("relative min-w-0", disabled && "bg-secondary/45", className)}
    >
      {children}
    </div>
  );
}
