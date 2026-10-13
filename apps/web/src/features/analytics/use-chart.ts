import { type KeyboardEvent, useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * The width of a chart's container, following resizes. Starts at `fallback` so the first render
 * (and environments without layout) still draws something sensible.
 */
export function useChartWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = Math.floor(element.clientWidth);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Data points that work by pointer and keyboard. The points share one tab stop: arrow keys, Home
 * and End move between them, focus or hover shows the tooltip, Escape hides it. Nothing animates
 * as the active point moves.
 */
export function useChartPoints(count: number) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focused = useRef<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [tabStop, setTabStop] = useState(0);
  const stop = Math.min(tabStop, Math.max(0, count - 1));

  const move = useCallback((event: KeyboardEvent, index: number) => {
    const last = refs.current.length - 1;
    const target = (() => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          return Math.min(last, index + 1);
        case "ArrowLeft":
        case "ArrowUp":
          return Math.max(0, index - 1);
        case "Home":
          return 0;
        case "End":
          return last;
        default:
          return null;
      }
    })();
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (target === null) return;
    event.preventDefault();
    refs.current[target]?.focus();
  }, []);

  const pointProps = (index: number) => ({
    ref: (element: HTMLButtonElement | null) => {
      refs.current[index] = element;
      refs.current.length = count;
    },
    tabIndex: index === stop ? 0 : -1,
    onFocus: () => {
      focused.current = index;
      setTabStop(index);
      setActive(index);
    },
    onBlur: () => {
      focused.current = null;
      setActive(null);
    },
    onPointerEnter: () => setActive(index),
    onPointerLeave: () => setActive(focused.current),
    onKeyDown: (event: KeyboardEvent) => move(event, index),
  });

  return { active: active !== null && active < count ? active : null, pointProps };
}
