import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close to the end still counts as reading the latest message, in pixels. */
export const PIN_THRESHOLD = 8;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** `scrollTop` at the previous scroll event. */
  previousScrollTop: number;
}

export function distanceFromBottom(metrics: Omit<ScrollMetrics, "previousScrollTop">): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

/**
 * Whether the view follows new content after a scroll event. At the end it
 * does. Scrolling up, even a little, stops following so the reader keeps
 * their place. Anything else (scrolling down but not to the end, or content
 * growing below) leaves the decision as it was.
 */
export function nextPinned(
  pinned: boolean,
  metrics: ScrollMetrics,
  threshold = PIN_THRESHOLD,
): boolean {
  if (distanceFromBottom(metrics) <= threshold) return true;
  if (metrics.scrollTop < metrics.previousScrollTop) return false;
  return pinned;
}

export interface StickToBottom {
  /** Whether the view follows new content. */
  pinned: boolean;
  /** Jumps to the end and follows again. Never animated, so it never fights the stream. */
  scrollToBottom: () => void;
}

/**
 * Keeps a scroll container at its end while the reader is there: content
 * that grows (streaming text, a new message) or a container that shrinks (a
 * taller composer) scrolls along. Once the reader scrolls up, it stays put
 * and `pinned` turns false so the panel can offer a way back. `resetKey`
 * starts each conversation at its end.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  resetKey: unknown,
): StickToBottom {
  const pinnedRef = useRef(true);
  const previousTop = useRef(0);
  const [pinned, setPinned] = useState(true);

  const update = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  const stick = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    previousTop.current = element.scrollTop;
  }, [scrollRef]);

  const scrollToBottom = useCallback(() => {
    update(true);
    stick();
  }, [stick, update]);

  // A new conversation opens at its latest message.
  useLayoutEffect(() => {
    update(true);
    stick();
  }, [resetKey, stick, update]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = () => {
      const next = nextPinned(pinnedRef.current, {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        previousScrollTop: previousTop.current,
      });
      previousTop.current = element.scrollTop;
      if (next !== pinnedRef.current) update(next);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (pinnedRef.current) stick();
          });
    observer?.observe(element);
    if (contentRef.current) observer?.observe(contentRef.current);

    return () => {
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [scrollRef, contentRef, stick, update]);

  return { pinned, scrollToBottom };
}
