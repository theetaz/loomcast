# Captions and pacing

Most viewers watch shorts without sound for the first seconds, so captions and the rhythm of
cards carry the video. This skill explains what the runtime does with captions and how to write
and storyboard so it reads well.

## How captions are built

Captions come from the voice's word timings; nobody writes them by hand.

- A caption line holds at most **3 words or 18 characters**; a longer single word gets its own
  line.
- A caption shows at most **2 lines** and stays on screen for at least **0.6 s**.
- A new caption starts after a sentence ends or after a pause of half a second.
- Short gaps (up to 0.3 s) are bridged so captions do not flicker.
- Style `line` shows whole lines, the first in the style's accent colour. Style `word` dims the
  caption and lights each word up as it is spoken. The format's `visualTemplate.captions` picks
  the style, or turns captions off.

## Writing for captions

- Short words and short sentences make clean caption lines. A sentence of 6–12 words becomes
  two or three captions.
- Avoid long compound words, long numbers and URLs: they break lines badly. Say "about two
  million" rather than "1,987,412".
- Put the key word at the end of a sentence; it lands as the caption's last word.
- Do not repeat the spoken sentence on a card. Cards show the key term, number or structure;
  captions show the words.

## Pacing

- **Hook in under 3 seconds.** The first caption and the first card must state the promise.
- **Change the picture every 4–8 seconds.** Each card's `durationSec` sets its range; most
  styles allow 5–8 s per card. A 45 s short has roughly 6–9 frames.
- **One idea per frame.** If a segment holds two ideas, split it across two frames.
- **Cut on breath.** Frame boundaries sit on sentence ends or pauses in the voice timings.
- **Land the payoff.** The payoff gets a tier1 card that stays at least its minimum time; the
  call to action can share the last frame.
- **No dead air.** Gaps between frames show only the shell background; keep them under half a
  second.

## Reading speed

At about 150 spoken words a minute a caption is on screen for roughly a second, which is
comfortable for 3–6 words. If the format asks for a faster voice speed, write shorter sentences
rather than denser ones.
