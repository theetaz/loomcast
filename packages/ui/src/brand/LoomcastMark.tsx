import type * as React from "react";
import { useSvgIdPrefix } from "./svgId";

export type LoomcastMarkProps = Omit<React.ComponentProps<"svg">, "children"> & {
  /** Rendered width and height in pixels. */
  size?: number | string;
  /** Accessible name. Pass `aria-hidden` instead when the mark sits next to the word. */
  title?: string;
};

/**
 * The Loomcast mark: an ember warp and a white chevron weft woven over a Thread
 * tile to form a play button. Paths from design/brand/loomcast-mark.svg.
 */
export function LoomcastMark({ size = 32, title = "Loomcast", ...props }: LoomcastMarkProps) {
  const id = useSvgIdPrefix("lc-mark");
  const hidden = props["aria-hidden"] === true || props["aria-hidden"] === "true";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={hidden ? undefined : "img"}
      aria-label={hidden ? undefined : title}
      data-slot="loomcast-mark"
      {...props}
    >
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b63e6" />
          <stop offset="1" stopColor="#3d44c2" />
        </linearGradient>
        <linearGradient
          id={`${id}-warp`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="5"
          x2="0"
          y2="27"
        >
          <stop offset="0" stopColor="#f59a6e" />
          <stop offset="1" stopColor="#e5713f" />
        </linearGradient>
        <linearGradient
          id={`${id}-weft`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="5"
          x2="0"
          y2="27"
        >
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e6e8ff" />
        </linearGradient>
        <mask id={`${id}-cut-warp`} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path d="M14.19 20.88 7.41 23.89" stroke="#000" strokeWidth="5.4" />
        </mask>
        <mask id={`${id}-cut-weft`} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="#fff" />
          <path d="M10.8 5.9V13.33" stroke="#000" strokeWidth="5.4" />
        </mask>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-tile)`} />
      <path
        d="M10.8 5.42V26.58"
        fill="none"
        stroke={`url(#${id}-warp)`}
        strokeWidth="3.4"
        strokeLinecap="round"
        mask={`url(#${id}-cut-warp)`}
      />
      <path
        d="M5.8 7.4 25.2 16 5.8 24.6"
        fill="none"
        stroke={`url(#${id}-weft)`}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        mask={`url(#${id}-cut-weft)`}
      />
    </svg>
  );
}
