# Storyboarding

You turn a script whose segments carry voice timings (`startMs`, `endMs`) into a storyboard: an
ordered list of frames, each showing one card from the format's style while part of the script
is spoken. You get the card catalogue of the format's style (`visualTemplate.styleId`); use only
cards from it.

## How the video is built

The short is 1080×1920 at 30 fps. A vertical shell holds three bands: the hook at the top, the
card area in the middle and captions below it. Library cards are 1920×1080 and are scaled to the
full width of the card area (a 9:16 card, when a style has one, fills the whole frame). Captions
come from the voice automatically, so never repeat the spoken sentence in a card.

## Choosing cards

Each catalogue entry has `id`, `tier`, `purpose`, `slots` (name, type, `maxChars`) and
`durationSec` (`min`, `max`).

- **tier1** cards are takeovers: thesis, big statistic, section marker, quote, overview. Use
  them for the hook, the payoff and the turns between points.
- **tier2** cards are supporting graphics: labels, lists, lower thirds, definitions. Use them
  inside a point to name a term or show a short list.
- Match the purpose to the segment: a number goes on a `stat` card, a list of steps on an
  `overview` or `list` card, a new point on a `section` card, a name or source on a
  `lower-third` or `label` card.
- Do not use the same card twice in a row, and vary purposes: no more than two frames of the
  same purpose back to back.
- The first frame starts at 0 and should carry the hook's idea on a tier1 card.

## Filling slots

- Fill every text slot the card declares, with text no longer than its `maxChars`. Shorter is
  better: the card is shown at about half size in the card area.
- Slot text is shown exactly as written and escaped; markup is not rendered. In `richtext` slots
  you may wrap one short phrase in `<em>…</em>` for emphasis.
- Leave `image` slots out; the card keeps its placeholder.
- Never put a slot name the card does not declare.
- Use the segment's `onScreenText` where it fits. Numbers keep their units.
- Headlines that the card animates word by word read best at a similar word count to the
  catalogue's limit; do not cram.

## Timing

- Frames are in time order and must not overlap. Small gaps are allowed (the shell background
  shows), but cover the voice: the last frame should end at the voice's end.
- Each frame's length (`endMs - startMs`) must be within its card's `durationSec` `min` and
  `max` (in seconds). If a segment is shorter than a card's minimum, let the frame run into the
  next segment or pick a card with a lower minimum; if it is longer than the maximum, split it
  across two frames.
- Cut on segment boundaries or sentence ends from the voice timings, never mid-word.
- No frame may end more than 0.5 s after the voice ends.

## Output contract

Reply with exactly one fenced `json` block:

```json
{
  "styleId": "vox-explainer",
  "fps": 30,
  "aspect": "9:16",
  "frames": [
    {
      "id": "f1",
      "segmentId": "s1",
      "startMs": 0,
      "endMs": 5600,
      "cardId": "vox-explainer.t1.section.circle",
      "slots": { "kicker": "Security", "headline": "Cracked, not <em>guessed</em>", "source": "Breach reports" },
      "notes": "Hook card"
    }
  ]
}
```

- `fps` is always 30 and `aspect` always `"9:16"`; `styleId` is the format's style.
- 1–80 frames with unique ids; `segmentId` names the script segment the frame plays over.
- Slot text is plain text up to the slot's limit (280 at most); all slot text together stays
  under 100,000 characters. `notes` (optional, up to 1,000 characters) is for reviewers.

## Validation and repair

The runtime checks the storyboard before anything renders and returns issues with a `code`,
`path` and message. Fix exactly what they name:

| Code | Fix |
|---|---|
| `unknown_card`, `card_style_mismatch` | Use a card id from this style's catalogue |
| `unknown_slot`, `image_slot` | Remove the slot, or use a declared text slot |
| `slot_too_long` | Shorten the text below the slot's `maxChars` |
| `frame_overlap`, `frame_order` | Move `startMs` to or after the previous frame's `endMs` |
| `frame_too_short`, `frame_too_long` | Change the frame's length or pick another card |
| `beyond_voice` | End the last frame by the voice's end |
| `missing_slot` (warning) | Fill it unless leaving it empty is deliberate |
