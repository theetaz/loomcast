// Gives focus back to a post's chip after a keyboard move. The chip re-mounts in its new cell, and
// the optimistic update, the save, a refetch and live events can re-render or replace it in any
// order. So instead of focusing once, the post stays "pending" and its chip takes focus whenever
// focus has fallen to the body: on every board commit, whenever the chip mounts, and after a blur
// with nowhere to go. It never takes focus from another element, and stops as soon as the user
// clicks or tabs away, starts another drag, or after a while.

/** How long a pending post keeps its claim on focus. */
const PENDING_MS = 30_000;

let pending: { postId: string; until: number } | null = null;

function clock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function onPointerDown() {
  forgetPostFocus();
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Tab") forgetPostFocus();
}

function onFocusOut(event: FocusEvent) {
  // Focus left an element for nothing: once the browser settles, see whether it fell to the body.
  if (event.relatedTarget === null) queueMicrotask(restorePostFocus);
}

function listen(on: boolean) {
  if (typeof document === "undefined") return;
  if (on) {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusout", onFocusOut, true);
  } else {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusout", onFocusOut, true);
  }
}

/** After a keyboard drop or cancel: the post's chip should end up with focus. */
export function returnFocusTo(postId: string) {
  if (!pending) listen(true);
  pending = { postId, until: clock() + PENDING_MS };
  restorePostFocus();
}

/** The user moved on (or started another drag): leave focus alone from now on. */
export function forgetPostFocus() {
  if (!pending) return;
  pending = null;
  listen(false);
}

/** Whether `postId` is waiting for focus, for chips deciding to claim it as they mount. */
export function isPendingFocus(postId: string): boolean {
  return pending?.postId === postId;
}

/**
 * Focuses the pending post's chip if focus is on the body (or nowhere). Looks the chip up by post
 * id every time, so a node replaced by a re-render is never the one focused.
 */
export function restorePostFocus() {
  if (!pending || typeof document === "undefined") return;
  if (clock() > pending.until) {
    forgetPostFocus();
    return;
  }
  const active = document.activeElement;
  if (active && active !== document.body) return;
  document.querySelector<HTMLElement>(`[data-post-chip="${pending.postId}"]`)?.focus();
}
