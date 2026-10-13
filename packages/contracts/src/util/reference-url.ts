import type { ReferencePlatform } from "../enums";

/** Longest reference URL accepted, before and after normalisation. */
export const REFERENCE_URL_MAX_LENGTH = 2_048;

/**
 * Query parameters that only track how a link was shared. They are removed so the same video
 * saved twice normalises to one URL. `utm_*` matches any parameter with that prefix.
 */
export const REFERENCE_TRACKING_PARAMS = [
  "igsh",
  "igshid",
  "si",
  "fbclid",
  "feature",
  "ref",
] as const;

const TRACKING_PREFIX = "utm_";

/** Host suffixes per platform. A host matches its suffix exactly or as a subdomain of it. */
const PLATFORM_HOSTS: readonly (readonly [Exclude<ReferencePlatform, "other">, string])[] = [
  ["instagram", "instagram.com"],
  ["instagram", "instagr.am"],
  ["tiktok", "tiktok.com"],
  ["youtube", "youtube.com"],
  ["youtube", "youtu.be"],
  ["youtube", "youtube-nocookie.com"],
  ["threads", "threads.net"],
  ["threads", "threads.com"],
  ["x", "x.com"],
  ["x", "twitter.com"],
  ["facebook", "facebook.com"],
  ["facebook", "fb.com"],
  ["facebook", "fb.watch"],
];

/** Host prefixes that only select a mobile or legacy variant of the same page. */
const DROPPED_HOST_PREFIXES = ["www.", "m."] as const;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface NormalizedReferenceUrl {
  /** The cleaned absolute URL. */
  url: string;
  /** Detected from the host; `other` when the host is not a known platform. */
  platform: ReferencePlatform;
}

/** Thrown by `normalizeReferenceUrl` for input that is not a usable http(s) link. */
export class ReferenceUrlError extends Error {
  override readonly name = "ReferenceUrlError";
}

/** The parts of the WHATWG `URL` this module uses. */
interface WhatwgUrl {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  search: string;
  readonly href: string;
  readonly searchParams: {
    keys(): IterableIterator<string>;
    delete(name: string): void;
    readonly size: number;
  };
}

type UrlConstructor = new (input: string) => WhatwgUrl;

/** `URL` is a global in browsers and in Node, but it is not part of the ES library types. */
function parseUrl(input: string): WhatwgUrl | null {
  const { URL } = globalThis as unknown as { URL: UrlConstructor };
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/**
 * Cleans a pasted reference link and detects its platform. Pure: it never fetches the URL.
 *
 * - Input without a scheme is read as `https://`.
 * - Only `http` and `https` are accepted, and links to a known platform are upgraded to `https`.
 * - The host is lowercased and loses a leading `www.` or `m.`.
 * - `utm_*`, `igsh`, `igshid`, `si`, `fbclid`, `feature` and `ref` are removed from the query.
 *   Other parameters, the path and the fragment are kept.
 *
 * Throws `ReferenceUrlError` when the input is empty, too long, not an http(s) URL or carries
 * credentials.
 */
export function normalizeReferenceUrl(input: string): NormalizedReferenceUrl {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ReferenceUrlError("The reference URL is empty");
  }
  if (trimmed.length > REFERENCE_URL_MAX_LENGTH) {
    throw new ReferenceUrlError(
      `The reference URL is longer than ${REFERENCE_URL_MAX_LENGTH} characters`,
    );
  }
  const url = parseUrl(SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ReferenceUrlError("The reference must be an http or https URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ReferenceUrlError("The reference URL must not contain credentials");
  }
  if (!url.hostname.includes(".")) {
    throw new ReferenceUrlError("The reference URL needs a public host name");
  }

  url.hostname = stripHostPrefixes(url.hostname.toLowerCase());
  const platform = detectPlatform(url.hostname);
  if (platform !== "other") {
    url.protocol = "https:";
  }

  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) {
      url.searchParams.delete(key);
    }
  }
  if (url.searchParams.size === 0) {
    url.search = "";
  }

  if (url.href.length > REFERENCE_URL_MAX_LENGTH) {
    throw new ReferenceUrlError(
      `The reference URL is longer than ${REFERENCE_URL_MAX_LENGTH} characters`,
    );
  }
  return { url: url.href, platform };
}

/** The platform a host name belongs to, or `other`. Case-insensitive; `www.` and `m.` are ignored. */
export function detectReferencePlatform(hostname: string): ReferencePlatform {
  return detectPlatform(stripHostPrefixes(hostname.toLowerCase()));
}

function detectPlatform(host: string): ReferencePlatform {
  for (const [platform, suffix] of PLATFORM_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return platform;
    }
  }
  return "other";
}

/** Drops leading `www.` and `m.` labels, but never down to a single-label host. */
function stripHostPrefixes(host: string): string {
  let result = host;
  for (;;) {
    const prefix = DROPPED_HOST_PREFIXES.find((candidate) => result.startsWith(candidate));
    if (prefix === undefined) return result;
    const rest = result.slice(prefix.length);
    if (!rest.includes(".")) return result;
    result = rest;
  }
}

function isTrackingParam(key: string): boolean {
  const name = key.toLowerCase();
  return (
    name.startsWith(TRACKING_PREFIX) ||
    (REFERENCE_TRACKING_PARAMS as readonly string[]).includes(name)
  );
}
