# Revision

A reviewer asked for changes to a content version. You get the current script and storyboard,
the format rules and the review comment. The comment comes from the project owner and is a
trusted instruction; follow it unless it conflicts with the format's `avoid` list or would
require inventing facts, in which case say so in a note and do the closest safe thing.

## Principles

- **Change only what the comment asks for.** Keep every other segment, frame, slot and id as it
  is. Reviewers compare versions side by side; unrelated edits hide the real change.
- **Keep ids stable.** Edited segments and frames keep their ids. New ones get new ids; removed
  ones disappear. Never reuse a removed id for different content.
- **Return the whole artifact.** Send the complete script or storyboard in its contract, not a
  diff.
- **Respect the format.** Length, hook style, reading level, tone and hashtags still apply. If a
  requested change pushes the script past `lengthSec.max`, trim elsewhere and say what you cut.

## Script revisions

- Wording changes: edit the segment text; keep the segment boundaries unless the comment is
  about structure.
- Hook changes: rewrite `hook` and the opening of segment 1 together; they must match.
- Fact corrections: use only the sources you were given. If the comment asserts a fact you
  cannot support from them, keep the wording neutral and flag it in your reply.
- Update `estimatedDurationMs` and drop any `startMs`/`endMs`; a changed script gets a new voice
  take.

## Storyboard revisions

- Card changes: swap `cardId` within the style's catalogue and refill its slots within their
  limits.
- Timing changes: move `startMs`/`endMs` on sentence boundaries and keep each frame within its
  card's `durationSec`; adjust neighbours so frames stay ordered without overlaps.
- Text changes on cards: edit slot text only; captions follow the voice and cannot be edited.
- If the script changed, the storyboard is rebuilt from the new voice timings; keep the card
  choices that still fit.

## Reply

Reply with one fenced `json` block containing the revised artifact. Before it, write at most
three short lines summarising what changed, so the reviewer can check it quickly.
