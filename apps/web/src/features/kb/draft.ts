import { z } from "zod";

const PREFIX = "loomcast.kb-draft.";

/** Unsaved editor content, kept in localStorage until it is saved or discarded. */
export const DraftSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  bodyMd: z.string(),
  /** The entry's `updatedAt` the draft started from; null for a new entry. */
  baseUpdatedAt: z.string().nullable(),
  savedAt: z.string(),
});
export type Draft = z.infer<typeof DraftSchema>;

/** The storage key of an entry's draft, or of a new entry of `kind` in a project. */
export function draftKey(
  target: { entryId: string } | { projectId: string; kind: string },
): string {
  return "entryId" in target
    ? `${PREFIX}${target.entryId}`
    : `${PREFIX}new.${target.projectId}.${target.kind}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readDraft(key: string): Draft | null {
  const raw = storage()?.getItem(key);
  if (!raw) return null;
  try {
    const parsed = DraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Storage can be full or disabled; a draft is a convenience, so failures are ignored. */
export function writeDraft(key: string, draft: Draft) {
  try {
    storage()?.setItem(key, JSON.stringify(draft));
  } catch {
    // Ignored: the editor keeps working without a stored draft.
  }
}

export function clearDraft(key: string) {
  try {
    storage()?.removeItem(key);
  } catch {
    // Ignored, as above.
  }
}
