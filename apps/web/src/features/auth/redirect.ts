/**
 * Where to go after signing in. Only same-origin paths are followed, so a
 * crafted `?next=https://…` or `?next=//host` link cannot send the user away.
 */
export function safeNextPath(next: string | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login#")) return "/";
  return next;
}
