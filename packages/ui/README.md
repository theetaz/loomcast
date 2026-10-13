# @loomcast/ui

shadcn/ui components with the Loomcast theme, the brand mark and the theme preference helper.
The package ships TypeScript and CSS sources; the consuming app compiles them with Vite and
Tailwind CSS v4.

## Use it from an app

Add the dependency:

```json
{ "dependencies": { "@loomcast/ui": "workspace:*" } }
```

Import the stylesheet once, in the app's main CSS file, and point Tailwind at the package
sources so the classes used by the components are generated:

```css
/* apps/web/src/styles.css */
@import "@loomcast/ui/styles.css";
@source "../../../packages/ui/src";
```

`styles.css` already imports `tailwindcss`, `tw-animate-css`, the Geist and Geist Mono
variable fonts, the brand tokens and the theme, so the app does not import them again. The
`@source` path is relative to the CSS file that contains it.

Then import what you need:

```tsx
import { LoomcastMark } from "@loomcast/ui/brand";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { cn } from "@loomcast/ui/lib/cn";
import { initTheme, useTheme } from "@loomcast/ui/lib/theme";
```

| Export | Contents |
|---|---|
| `./styles.css` | Tailwind, fonts, tokens and theme |
| `./components/*` | shadcn components (`button`, `dialog`, `sidebar`, …) and `StatusPill` (with `StatusDot`; kinds `pipeline`, `job`, `device`, `post` and `channel`) |
| `./hooks/*` | `use-mobile`, used by the sidebar |
| `./lib/*` | `cn`, `theme`, `motion` |
| `./brand` | `LoomcastMark`, `LoomcastGlyph` |

## Theme

- `src/styles/tokens.css` holds the raw tokens from `design/brand/loomcast-brand.html`, with
  an `lc-` prefix: light values on `:root`, dark values on `.dark`. The brand file is the
  source of truth; `test/tokens.test.ts` fails when the two drift apart.
- `src/styles/theme.css` maps them onto the shadcn variables (`--background`, `--primary`,
  `--accent`, …) and adds utilities: colours `ember`, `status-{green,amber,red,blue,violet,gray}`,
  `text-2`, `text-4`, `divider`, `accent-soft`; radii `sm` 4px, `md` 7px, `lg` 10px, `xl` 14px;
  type sizes `text-display`, `text-title`, `text-heading`, `text-body`, `text-control`,
  `text-small`, `text-mono` (pair it with `font-mono`); shadows `shadow-card`, `shadow-pop`,
  `shadow-focus`.
- Dark mode is the `dark` class on `<html>`. `lib/theme.ts` stores a `system`, `light` or
  `dark` preference in localStorage and applies it with transitions paused, because theme
  changes are never animated. Call `initTheme()` before the first render, read and change the
  preference with `useTheme()`, and inline `themeInitScript` in `index.html` to avoid a flash
  of the wrong theme.

## Motion

The rules come from the brand kit and are enforced by `test/styles.test.ts`.

| Use | Duration | Utility |
|---|---|---|
| Button press (scale 0.97) | 140ms, `--lc-ease` | `pressable` |
| Menus, selects, tooltips, dialogs in | 160ms | `duration-menu-in` |
| … out | 100ms | `duration-menu-out` |
| Tabs indicator, sidebar collapse, sheets in | 220ms | `duration-tabs` |
| Toasts in / out | 400ms / 200ms, `ease` | `duration-toast-in`, `duration-toast-out` |
| Colour changes | 150ms, `ease` | `transition-colors` (default) |

- `ease-out` is the brand curve `cubic-bezier(.23, 1, .32, 1)`, `ease-in-out` is
  `cubic-bezier(.77, 0, .175, 1)` and `ease-sheet` is `cubic-bezier(.32, .72, 0, 1)`.
- Floating surfaces scale from their trigger (`transform-origin` from Radix); modals stay centred.
  `lib/motion.ts` has the shared enter and exit classes.
- `hover:` only applies on devices with `(hover: hover) and (pointer: fine)`.
- Keyboard-driven changes do not animate: the sidebar shortcut and arrow keys in tabs jump.
  The command menu (`command`, built on cmdk) opens, highlights and closes without any
  animation, because it is opened from the keyboard many times a day.
- Under `prefers-reduced-motion` fades stay and movement goes: no scale, slide or press.
- Name the properties a transition animates; never transition all of them.

## Adding components

`components.json` is set up for the shadcn CLI. Run it from this directory:

```sh
npx shadcn@latest add <component>
```

The generated file imports `cn` from the `cn` package; change it to `@loomcast/ui/lib/cn`,
then restyle it to the tokens and motion rules above.
