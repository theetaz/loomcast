import type { JsonObject } from "@loomcast/contracts";

// Every request the publisher stores in `publish_attempts.request` goes through `redactRequest`
// first: the database cannot tell a token from any other string, so the publisher must.

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/**
 * Keys whose values are credentials, compared case-insensitively after removing `-` and `_`:
 * `access_token`, `Authorization`, `client_secret`, `appsecret_proof`, `refresh_token` and so on.
 */
const SENSITIVE_KEY_RE =
  /^(authorization|proxyauthorization|cookie|setcookie|password|secret|token|code|codeverifier|clientsecret|appsecret|appsecretproof|accesstoken|refreshtoken|inputtoken|fbexchangetoken|idtoken|apikey|signature|xamzsignature|xamzsecuritytoken|xamzcredential)$/;

/** Key fragments that mark a credential wherever they appear in a key. */
const SENSITIVE_PART_RE = /(token|secret|password|authorization|signature|credential)/;

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_KEY_RE.test(normalised) || SENSITIVE_PART_RE.test(normalised);
}

/** Removes credential query parameters from a URL string; other strings are returned as they are. */
function redactUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || !value.includes("?")) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 32) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactUrl(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        continue;
      }
      result[key] =
        isSensitiveKey(key) && entry !== null && typeof entry !== "boolean"
          ? REDACTED
          : redactValue(entry, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * A deep copy of `request` with every credential replaced by `[redacted]`: values under sensitive
 * keys (headers, form fields and JSON fields alike) and sensitive query parameters of URLs.
 * Redacting twice changes nothing, so `redactRequest(buildX(...))` equals what the dry-run
 * adapter records.
 */
export function redactRequest<T extends JsonObject>(request: T): T {
  return redactValue(request, 0) as T;
}
