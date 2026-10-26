import {
  KB_TITLE_MAX_LENGTH,
  type ReferenceAnalysis,
  type ReferencePlatform,
} from "@loomcast/contracts";
import { referenceSearchExtra } from "@loomcast/db";

/** How much of a transcript goes into the search document; the rest is stored but not indexed. */
export const REFERENCE_SEARCH_TRANSCRIPT_LENGTH = 20_000;

const PLATFORM_LABELS: { readonly [P in ReferencePlatform]: string } = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
  x: "X",
  facebook: "Facebook",
  other: "Web",
};

/** The dedupe key of a reference: one live entry per normalised URL and workspace. */
export function referenceDedupeKey(normalizedUrl: string): string {
  return `ref:${normalizedUrl}`;
}

/** `Instagram reference by sample.creator`, or `YouTube reference` without an author. */
export function defaultReferenceTitle(platform: ReferencePlatform, author?: string | null): string {
  const label = `${PLATFORM_LABELS[platform]} reference`;
  const title =
    author === undefined || author === null || author === "" ? label : `${label} by ${author}`;
  return title.length > KB_TITLE_MAX_LENGTH
    ? `${title.slice(0, KB_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;
}

/**
 * The hidden search text of a reference: author, why it was liked, the first
 * `REFERENCE_SEARCH_TRANSCRIPT_LENGTH` characters of the transcript and the analysis takeaways.
 */
export function referenceSearchText(reference: {
  author?: string | null;
  likedReason?: string | null;
  transcript?: string | null;
  analysis?: ReferenceAnalysis | null;
}): string {
  const base = referenceSearchExtra({
    author: reference.author,
    likedReason: reference.likedReason,
    transcript: reference.transcript?.slice(0, REFERENCE_SEARCH_TRANSCRIPT_LENGTH),
  });
  const takeaways = reference.analysis?.takeaways ?? [];
  return [base, ...takeaways].filter((part) => part.trim() !== "").join("\n");
}

/** Blank optional text is stored as null. */
export function optionalText(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === "" ? null : value;
}
