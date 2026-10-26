import type { ReactNode } from "react";

/** A crumb is a label, or a render function for labels that need data, such as a workspace name. */
export type Breadcrumb = string | ((params: Record<string, string>) => ReactNode);

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    breadcrumb?: Breadcrumb;
  }
}
