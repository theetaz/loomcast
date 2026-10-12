import { useId } from "react";

/** A per-instance prefix for SVG ids, so several marks on one page never share gradients. */
export function useSvgIdPrefix(name: string): string {
  return `${name}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
