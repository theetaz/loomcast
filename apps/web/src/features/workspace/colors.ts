import type { WorkspaceColor } from "@loomcast/contracts";

export interface WorkspaceColorMeta {
  label: string;
  /** A tint with text in the colour, for avatars without an image. */
  soft: string;
  /** The colour itself, for swatches. */
  solid: string;
}

/**
 * Each workspace colour mapped to theme tokens, so it follows light and dark mode. Full class names,
 * so Tailwind finds them. `thread` and `ember` are the brand colours.
 */
export const WORKSPACE_COLOR_META: Record<WorkspaceColor, WorkspaceColorMeta> = {
  thread: { label: "Thread", soft: "bg-primary/12 text-primary", solid: "bg-primary" },
  ember: { label: "Ember", soft: "bg-ember/12 text-ember", solid: "bg-ember" },
  moss: { label: "Moss", soft: "bg-status-green/12 text-status-green", solid: "bg-status-green" },
  ocean: { label: "Ocean", soft: "bg-status-blue/12 text-status-blue", solid: "bg-status-blue" },
  plum: {
    label: "Plum",
    soft: "bg-status-violet/12 text-status-violet",
    solid: "bg-status-violet",
  },
  amber: { label: "Amber", soft: "bg-status-amber/12 text-status-amber", solid: "bg-status-amber" },
  rose: { label: "Rose", soft: "bg-status-red/12 text-status-red", solid: "bg-status-red" },
  slate: { label: "Slate", soft: "bg-status-gray/14 text-text-2", solid: "bg-status-gray" },
};
