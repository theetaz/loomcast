import type { KbEntryKind, ReferencePlatform } from "@loomcast/contracts";
import {
  AtSignIcon,
  CameraIcon,
  GlobeIcon,
  HashIcon,
  HistoryIcon,
  LightbulbIcon,
  Link2Icon,
  type LucideIcon,
  Music2Icon,
  NotebookPenIcon,
  PlayIcon,
  ScaleIcon,
  UsersIcon,
} from "lucide-react";

export interface KindMeta {
  /** One entry: "Brainstorm". */
  label: string;
  /** The filter: "Brainstorms". */
  plural: string;
  icon: LucideIcon;
  /** Full class names, so Tailwind finds them. */
  tone: string;
}

export const KIND_META: Record<KbEntryKind, KindMeta> = {
  brainstorm: {
    label: "Brainstorm",
    plural: "Brainstorms",
    icon: LightbulbIcon,
    tone: "text-status-amber",
  },
  reference: {
    label: "Reference",
    plural: "References",
    icon: Link2Icon,
    tone: "text-status-blue",
  },
  decision: { label: "Decision", plural: "Decisions", icon: ScaleIcon, tone: "text-status-violet" },
  note: { label: "Note", plural: "Notes", icon: NotebookPenIcon, tone: "text-status-green" },
  session_summary: {
    label: "Session summary",
    plural: "Sessions",
    icon: HistoryIcon,
    tone: "text-status-gray",
  },
};

/** The kind filter of the knowledge list, in display order. */
export const KB_FILTERS = [
  "all",
  "brainstorm",
  "reference",
  "decision",
  "note",
  "session_summary",
] as const;
export type KbFilter = (typeof KB_FILTERS)[number];

export function filterLabel(filter: KbFilter): string {
  return filter === "all" ? "All" : KIND_META[filter].plural;
}

/** The kinds a filter asks the API for; `undefined` is every kind. */
export function filterKinds(filter: KbFilter): KbEntryKind[] | undefined {
  return filter === "all" ? undefined : [filter];
}

/** Kinds the web app writes. Session summaries come only from producer sessions over MCP. */
export const CREATABLE_KINDS = ["brainstorm", "note", "decision"] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export const PLATFORM_META: Record<ReferencePlatform, { label: string; icon: LucideIcon }> = {
  instagram: { label: "Instagram", icon: CameraIcon },
  tiktok: { label: "TikTok", icon: Music2Icon },
  youtube: { label: "YouTube", icon: PlayIcon },
  threads: { label: "Threads", icon: AtSignIcon },
  x: { label: "X", icon: HashIcon },
  facebook: { label: "Facebook", icon: UsersIcon },
  other: { label: "Web", icon: GlobeIcon },
};
