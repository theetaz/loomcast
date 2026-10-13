import { PASSWORD_TOKEN_RE } from "@loomcast/contracts";

/**
 * The set-password token from a link's fragment (`/set-password#token=…`), or
 * null when the fragment has none or it is malformed. Fragments never reach the
 * server, so the token does not end up in access logs or `Referer` headers.
 */
export function readPasswordToken(hash: string): string | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment) return null;
  const token = new URLSearchParams(fragment).get("token");
  return token && PASSWORD_TOKEN_RE.test(token) ? token : null;
}
