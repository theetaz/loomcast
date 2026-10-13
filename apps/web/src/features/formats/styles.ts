import {
  CAPTION_STYLES,
  type CaptionStyle,
  HOOK_STYLES,
  type HookStyle,
} from "@loomcast/contracts";

/**
 * Styles of the studio's style library (`studio/style-library/registry.json`). The browser can't
 * read the studio's files and the API has no style catalogue yet, so the editor keeps this short
 * list. A format may still name a style that is not listed here: the contracts check the id's
 * shape only, and the studio runtime validates it against the registry it has.
 */
export interface StyleOption {
  id: string;
  name: string;
  hint: string;
}

export const STYLE_OPTIONS: readonly StyleOption[] = [
  {
    id: "vox-explainer",
    name: "Vox Explainer",
    hint: "Paper collage of engravings and halftone photos, high-contrast serif type and one blue shape per beat. Choppy stop-motion with camera moves into shallow depth.",
  },
  {
    id: "kallaway",
    name: "Kallaway",
    hint: "Premium dark explainer: near-black canvas with a blue glow from below, glass cards and pills, edge-lit frames and smooth gliding motion.",
  },
];

export function styleOption(id: string): StyleOption | undefined {
  return STYLE_OPTIONS.find((style) => style.id === id);
}

export const HOOK_STYLE_LABELS: Record<HookStyle, { label: string; hint: string }> = {
  question: { label: "Question", hint: "Open with a question the viewer wants answered." },
  bold_claim: { label: "Bold claim", hint: "Open with a confident statement worth checking." },
  statistic: { label: "Statistic", hint: "Open with a surprising number." },
  story: { label: "Story", hint: "Open in the middle of a short story." },
  contrarian: { label: "Contrarian", hint: "Open by disagreeing with common advice." },
  demo: { label: "Demo", hint: "Open on the result, then show how it was made." },
};

export const CAPTION_STYLE_LABELS: Record<CaptionStyle, { label: string; hint: string }> = {
  word: { label: "Word by word", hint: "Highlights each spoken word as it is said." },
  line: { label: "Whole lines", hint: "Shows complete caption lines." },
};

// Keep the label tables in step with the contracts.
export const HOOK_STYLE_IDS = HOOK_STYLES;
export const CAPTION_STYLE_IDS = CAPTION_STYLES;
