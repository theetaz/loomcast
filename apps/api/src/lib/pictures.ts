import type { FetchLike } from "./meta-graph";

// Profile pictures of connected accounts. The platforms hand out picture addresses on their own
// image hosts, which the web app's content security policy does not allow, so the API fetches a
// picture and passes it through (`channels.picture`, `oauth.connectionPicture`). Only https
// addresses on the platforms' image hosts are ever fetched, without following redirects, so a
// stored address can never make the server call anything else. Picture addresses expire after a
// while; the daily channel check stores a fresh one.

/** Image hosts of the platforms, matched as the host itself or any subdomain of it. */
export const PICTURE_HOSTS = ["fbcdn.net", "fbsbx.com", "cdninstagram.com", "twimg.com"] as const;

/** Longest picture address kept. */
export const PICTURE_URL_MAX_LENGTH = 2_048;

/** Largest picture passed through. */
export const PICTURE_MAX_BYTES = 2 * 1024 * 1024;

/** Longest a picture fetch may take, including reading the body. */
export const PICTURE_TIMEOUT_MS = 5_000;

/** How long a browser may reuse a picture. */
export const PICTURE_MAX_AGE_SECONDS = 24 * 60 * 60;

const PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** The address when it is an https address on a platform image host, otherwise undefined. */
export function pictureUrlOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > PICTURE_URL_MAX_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const allowed = PICTURE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return allowed ? url.toString() : undefined;
}

/** A short stable tag of a picture address, so the web app's path changes with the picture. */
export function pictureVersion(url: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface Picture {
  body: Uint8Array;
  contentType: string;
}

/**
 * Fetches the picture at `url`. Null when the address is not allowed, the platform does not serve
 * it (an expired address answers 403 or 404), the response is not a known image type, or it is
 * larger than `PICTURE_MAX_BYTES`. Network failures are null too: a missing picture falls back to
 * the initials.
 */
export async function fetchPicture(
  url: string,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<Picture | null> {
  const allowed = pictureUrlOf(url);
  if (allowed === undefined) {
    return null;
  }
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const signal =
    options.signal === undefined
      ? AbortSignal.timeout(PICTURE_TIMEOUT_MS)
      : AbortSignal.any([options.signal, AbortSignal.timeout(PICTURE_TIMEOUT_MS)]);
  try {
    const response = await doFetch(allowed, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { accept: "image/*" },
    });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return null;
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (!PICTURE_TYPES.has(contentType.toLowerCase()) || declared > PICTURE_MAX_BYTES) {
      await response.body.cancel();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > PICTURE_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body, contentType: contentType.toLowerCase() };
  } catch {
    return null;
  }
}

/** The response that passes `picture` through, cached privately by the browser. */
export function pictureResponse(picture: Picture): Response {
  return new Response(picture.body, {
    status: 200,
    headers: {
      "Content-Type": picture.contentType,
      "Content-Length": String(picture.body.byteLength),
      "Cache-Control": `private, max-age=${PICTURE_MAX_AGE_SECONDS}`,
    },
  });
}
