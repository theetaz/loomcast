/**
 * Shared enter and exit motion for floating surfaces, built on tw-animate-css.
 * Surfaces fade and scale from 0.97 in 160ms and leave in 100ms on the brand
 * ease-out curve; under reduced motion only the fade remains (theme.css).
 * Anchored surfaces also set `transform-origin` to their trigger.
 */
export const surfaceMotion =
  "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-97 data-open:duration-menu-in data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-97 data-closed:duration-menu-out";

/** Fade-only variant for backdrops behind dialogs and sheets. */
export const overlayMotion =
  "data-open:animate-in data-open:fade-in-0 data-open:duration-menu-in data-closed:animate-out data-closed:fade-out-0 data-closed:duration-menu-out";
