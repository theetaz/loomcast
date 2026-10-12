import type * as React from "react";
import { useSvgIdPrefix } from "./svgId";

export type LoomcastGlyphProps = Omit<React.ComponentProps<"svg">, "children"> & {
  /** Rendered height in pixels; the width follows the 24:25 view box. */
  size?: number | string;
  /** Accessible name. Pass `aria-hidden` instead when the glyph sits next to the word. */
  title?: string;
};

/**
 * The woven play glyph without its tile. The weft takes `currentColor`, so it
 * reads on any surface; the warp stays ember. Paths from design/brand/loomcast-glyph.svg.
 */
export function LoomcastGlyph({ size = 24, title = "Loomcast", ...props }: LoomcastGlyphProps) {
  const id = useSvgIdPrefix("lc-glyph");
  const hidden = props["aria-hidden"] === true || props["aria-hidden"] === "true";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="3.5 3.5 24 25"
      width={typeof size === "number" ? (size * 24) / 25 : undefined}
      height={size}
      role={hidden ? undefined : "img"}
      aria-label={hidden ? undefined : title}
      data-slot="loomcast-glyph"
      {...props}
    >
      <defs>
        <mask id={`${id}-cut-warp`} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path d="M14.19 20.88 7.41 23.89" stroke="#000" strokeWidth="5.4" />
        </mask>
        <mask id={`${id}-cut-weft`} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path d="M10.8 5.9V13.33" stroke="#000" strokeWidth="5.4" />
        </mask>
      </defs>
      <path
        d="M10.8 5.42V26.58"
        fill="none"
        stroke="#e8784a"
        strokeWidth="3.4"
        strokeLinecap="round"
        mask={`url(#${id}-cut-warp)`}
      />
      <path
        d="M5.8 7.4 25.2 16 5.8 24.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        mask={`url(#${id}-cut-weft)`}
      />
    </svg>
  );
}
