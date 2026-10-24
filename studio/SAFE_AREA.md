# Safe-area rules for vertical video

Every Loomcast short renders at the full 1080×1920 frame, edge to edge. Platforms then crop
the frame to fit the screen and draw their own controls on top of it. These rules define
where content may sit so that nothing the viewer needs is cut off or covered, on any phone, on
Instagram Reels, YouTube Shorts and Threads.

The rule in one line: **the canvas is full bleed, the content is not.** Backgrounds fill the
frame; everything that carries meaning lives inside the safe areas below.

All coordinates are frame pixels on the 1080×1920 canvas, origin top-left, x to the right,
y down. Ranges are half-open: `x 90–990` means `90 ≤ x < 990`.

---

## 1. Why the frame is not fully visible

Two independent effects remove parts of the frame.

1. **Fill cropping.** Phones are taller than 9:16. The player scales the video until it fills
   the height of its viewport and crops the excess width equally from both sides.

   ```
   visible width fraction = viewport aspect (w/h) ÷ 0.5625
   side loss (frame px)   = (1080 − 1080 × visible fraction) ÷ 2
   ```

   | Device class                    | Viewport aspect | Side loss per edge |
   | ------------------------------- | --------------- | ------------------ |
   | iPhone 19.5:9 (measured)        | ≈ 0.506         | ≈ 56 px            |
   | Android 20:9                    | ≈ 0.495         | ≈ 65 px            |
   | Android 21:9                    | ≈ 0.471         | ≈ 88 px            |
   | 16:9 phones (iPhone SE)         | ≈ 0.608         | 0 px; loses ≈ 70 px top and bottom instead |

   The viewport is the screen minus the platform's bottom navigation bar, which is why the
   aspect is wider than the raw screen.

2. **Overlay chrome.** The platform draws UI over the video: the status bar and top buttons,
   the like/comment/share column on the right, and the account name, caption and audio line
   at the bottom. Video under these controls is technically visible but unreadable.

Measured reference (Instagram Reels, iPhone 19.5:9, 2026-10-16), in frame pixels:

| Overlay                         | Region                    |
| ------------------------------- | ------------------------- |
| Side crop                       | x 0–56 and x 1024–1080    |
| Status bar                      | y 0–86                    |
| Back and camera buttons         | y ≈ 160–216               |
| Like/comment/share column       | x ≈ 920–1000, y ≈ 1100–1880 |
| Account name and caption        | x ≥ 88, y ≈ 1740–1880     |

The zones in section 2 take the union of all three platforms plus a margin. Feed
placements crop further: Instagram shows Reels in the main feed at 4:5 (y 285–1635) and on
the profile grid at 3:4 (y 240–1680). The text-safe area sits inside both.

---

## 2. Zones

```
 x: 0   90 120                          840  870   960 990 1080
 y:0 ┌───┬──┬─────────────────────────────┬────┬────┬──┬───┐
     │   :  :      TOP CHROME BAND (0–250)                 │
 250 │   :  ┌──────────────── GSA ───────────────────────┐ │
 290 │ C :  │  ┌───────────── TSA ─────────────────┐     │ │ C
     │ R :  │  │                                   │     │ │ R
     │ O :  │  │                                   │     │ │ O
     │ P :  │  │                                   │     │ │ P
 960 │   :  │  │                       ┌───────────┴─────┤ │
     │ B :  │  │                       │   ACTION RAIL   │ │ B
     │ A :  │  │                       │  (870–1080,     │ │ A
     │ N :  │  │                       │   960–1920)     │ │ N
1490 │ D :  │  └───────────────────────┤                 │ │ D
1520 │   :  └──────────────────────────┤                 │ │
     │   :     BOTTOM CHROME BAND (1520–1920)            │ │
1920 └───┴─────────────────────────────┴─────────────────┴─┘
```

| Zone                         | Definition                                                     | Purpose |
| ---------------------------- | -------------------------------------------------------------- | ------- |
| **Canvas (bleed)**           | x 0–1080, y 0–1920                                              | The rendered frame. Always fully painted. |
| **Crop band**                | x 0–90 and x 990–1080, full height                              | May be cropped away on tall phones. |
| **Top chrome band**          | y 0–250, full width                                             | Status bar, back and camera buttons, tab header. |
| **Bottom chrome band**       | y 1520–1920, full width                                         | Account name, caption (expanded), audio line, Shorts title and subscribe button, progress bar. |
| **Action rail**              | x 870–1080, y 960–1920                                          | Like, comment, share, save, more, audio avatar. |
| **Graphic-safe area (GSA)**  | x 90–990, y 250–1520, minus the action rail                     | Every key graphic must sit fully inside it. |
| **Text-safe area (TSA)**     | x 120–960, y 290–1490, minus x 840–960 for y ≥ 960              | Every readable glyph must sit fully inside it. |

Derived edges for layout:

- Text left edge: **x = 120**.
- Text right edge: **x = 960** above y 960, **x = 840** at or below y 960.
- Text top edge: **y = 290**. Text bottom edge: **y = 1490**.
- Horizontal centre of the TSA: **x = 540** above y 960, **x = 480** below it. Centre text
  on the TSA, not on the frame, when it sits beside the action rail.

### Canonical values

Every template, preview overlay and checker reads these numbers from one place. Do not
copy them into code by hand; import them.

```json
{
  "frame": { "width": 1080, "height": 1920 },
  "cropBand": { "left": 90, "right": 990 },
  "chrome": {
    "top": { "y1": 250 },
    "bottom": { "y0": 1520 },
    "rail": { "x0": 870, "y0": 960 }
  },
  "graphicSafe": {
    "x0": 90, "y0": 250, "x1": 990, "y1": 1520,
    "exclude": [{ "x0": 870, "y0": 960, "x1": 990, "y1": 1520 }]
  },
  "textSafe": {
    "x0": 120, "y0": 290, "x1": 960, "y1": 1490,
    "exclude": [{ "x0": 840, "y0": 960, "x1": 960, "y1": 1490 }]
  }
}
```

---

## 3. Content classes

Every visible element belongs to exactly one class. The class decides which zone it must
respect.

| Class | Name       | What belongs here                                                                 | Constraint |
| ----- | ---------- | --------------------------------------------------------------------------------- | ---------- |
| **T** | Text       | Words, numbers, units, labels, captions, the wordmark, calls to action.           | Ink box fully inside the **TSA**. |
| **K** | Key        | Any part the narration names, the end of a label's leader line, data marks, the logo glyph, the focal point of a shot. | Box fully inside the **GSA**. |
| **S** | Supporting | The rest of a hero object: housings, plates, frames, secondary parts.             | May cross into the crop band and off frame, within the limits in rule S1–S3. |
| **O** | Ornament   | Information-free texture text and marks: figure numbers, timecodes, registration marks, corner ticks. | Inside x 90–990. Losing it to chrome must cost the viewer nothing. |
| **B** | Bleed      | Background, paper, grid, grain, vignette, particles, base-plate extensions.       | Anywhere. Must cover the full canvas. |

Unmarked elements default as follows: any visible text is **T**; any other graphic is **S**.
An element is classed by its role at that moment, so a part becomes **K** only while the
narration or a label refers to it.

### Rules

- **T1.** A **T** element's ink box, including strokes, halos, shadows and descenders, lies
  fully inside the TSA on every frame where it is readable.
- **T2.** Text is never placed in the action rail or a chrome band, even when it would be
  "only briefly" covered.
- **T3.** Multi-line text wraps to the TSA width at that y. Below y 960 the usable width is
  720 px (x 120–840), not 840.
- **K1.** A **K** element's box lies fully inside the GSA on every frame where it is the subject.
- **K2.** A label's text obeys T1; the end of its leader line obeys K1. The line itself may
  cross any zone except the action rail.
- **S1.** No **K** part of an object may be cut off by the frame edge or the crop band.
- **S2.** At most 15 % of an object's rendered width may sit outside x 90–990. For an object
  that bleeds on both sides this caps its width at about 1060 px.
- **S3.** An object's visual centre of mass lies inside the GSA.
- **O1.** Ornaments stay inside x 90–990 and may sit in the top chrome band. They never carry
  information that is not repeated elsewhere.
- **B1.** Bleed layers fill the canvas so that no crop or aspect ever shows an unpainted edge.

---

## 4. Motion

The rules apply to the **rendered** position of each element, after every transform, camera
move and scale, not to its layout position.

- **M1. Readable window.** A **T** or **K** element is bound by its zone from the end of its
  entrance to the start of its exit. During an entrance or exit of at most 0.6 s it may travel
  through any zone.
- **M2. Camera moves.** Plan push-ins, pans and zooms so that every **K** element stays in the
  GSA for the whole move. If a part must leave the GSA, the narration must have moved off it
  first.
- **M3. Scale overshoot.** Spring or `back` easing must stay inside the zone at the peak of
  the overshoot, not only at rest.
- **M4. Held frames.** The first frame (hook) and the frame chosen for the cover follow T1 and
  K1 strictly, with no M1 allowance. They also sit inside the 4:5 feed crop (y 285–1635),
  which the TSA already guarantees.

---

## 5. Measuring

- **Ink box, not layout box.** Measure the painted extent of the element in frame pixels.
  - For SVG, use the rendered bounding box in the root's coordinate space, then add half the
    stroke width, the full halo stroke (`paint-order: stroke`), and any shadow or glow radius.
  - Ignore letter-spacing that trails the last glyph. With `text-anchor: end` that trailing
    gap otherwise makes text look further from the edge than it is.
- **Sampling.** The checker samples every 3 frames (0.1 s at 30 fps) for drafts and every
  frame for the final render.
- **Tolerance.** Zero. One pixel outside the zone is a failure.

---

## 6. Enforcement

1. **Markup.** Tag elements with `data-safe="text|key|support|ornament|bleed"` wherever the
   default class (section 3) is wrong. Tag parts that become **K** only while the narration
   refers to them with `data-safe-key="start-end"`, giving the times in seconds.
2. **Preview overlay.** The preview and contact-sheet tools draw the zones over every frame
   when asked: the crop band, both chrome bands, the action rail, the GSA outline and the TSA
   outline. The overlay is never present in a render.
3. **Checker.** A headless pass seeks the composition at the sample times and measures every
   **T** and **K** element against its zone. For each violation it reports the element, the
   time, the zone and the overflow in pixels on each side, then exits non-zero.
4. **Review gate.** A video is not published until the checker passes and a reviewer has
   looked at the overlay contact sheet. The review notes record both.

---

## 7. Keeping the numbers current

These values are measurements of third-party apps and will drift when the apps change.

- Re-measure every quarter, and whenever a platform redesigns its player.
- To re-measure:
  1. Render a ruler card: the full frame with a numbered line every 20 px on both axes.
  2. Post it as a private or test upload on each platform.
  3. Screenshot it on the shortest and tallest phone available.
  4. Read off the first and last visible ruler lines and the extent of each overlay.
- Update the canonical values in section 2, note the date and devices in section 1, and
  re-run the checker on any unpublished video.
