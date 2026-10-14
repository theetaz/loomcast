import type { CompetitorPlatform } from "../enums";
import { detectReferencePlatform, normalizeReferenceUrl, ReferenceUrlError } from "./reference-url";

// Competitor profiles and the public video links the studio agent may download. Pure: nothing here
// fetches a URL. The same checks run on the server (before a job is queued) and in the studio agent
// (before it starts the downloader), so a link outside the platforms is never fetched.

/** A handle: letters, digits, `.`, `_` and `-`, as the three platforms allow them. */
export const COMPETITOR_HANDLE_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Path segments that are pages of the platform itself, not a profile. */
const RESERVED_SEGMENTS: Readonly<Record<CompetitorPlatform, ReadonlySet<string>>> = {
  instagram: new Set([
    "p",
    "reel",
    "reels",
    "tv",
    "stories",
    "explore",
    "accounts",
    "direct",
    "about",
    "developer",
    "legal",
  ]),
  facebook: new Set([
    "watch",
    "reel",
    "share",
    "groups",
    "events",
    "marketplace",
    "gaming",
    "login",
    "help",
    "profile.php",
    "pages",
    "story.php",
    "photo",
    "photo.php",
    "video.php",
  ]),
  threads: new Set(["login", "search", "activity", "settings"]),
};

export interface CompetitorProfile {
  platform: CompetitorPlatform;
  /** Without a leading `@`, as written in the link. */
  handle: string;
  /** The canonical profile URL. */
  profileUrl: string;
}

/** Thrown by `parseCompetitorUrl` for a link that is not a supported profile. */
export class CompetitorUrlError extends Error {
  override readonly name = "CompetitorUrlError";
}

function isCompetitorPlatform(value: string): value is CompetitorPlatform {
  return value === "instagram" || value === "facebook" || value === "threads";
}

/**
 * Reads a competitor's profile from a pasted link (`instagram.com/<handle>`,
 * `facebook.com/<page>`, `threads.net/@<handle>`), or from `@handle` alone (or a handle without
 * dots), which is read as an Instagram handle. Throws `CompetitorUrlError` for anything else.
 */
export function parseCompetitorUrl(input: string): CompetitorProfile {
  const trimmed = input.trim();
  // `@name` (or a name without dots, which cannot be a host) is an Instagram handle.
  if (/^@[A-Za-z0-9._-]{1,100}$/.test(trimmed) || /^[A-Za-z0-9_-]{1,100}$/.test(trimmed)) {
    return profileOf("instagram", trimmed.replace(/^@/, ""));
  }
  let normalized: string;
  let platform: string;
  try {
    ({ url: normalized, platform } = normalizeReferenceUrl(trimmed));
  } catch (error) {
    if (error instanceof ReferenceUrlError) {
      throw new CompetitorUrlError(error.message);
    }
    throw error;
  }
  if (!isCompetitorPlatform(platform)) {
    throw new CompetitorUrlError("Paste an Instagram, Facebook or Threads profile link");
  }
  const { URL } = globalThis as unknown as { URL: new (input: string) => { pathname: string } };
  const segments = new URL(normalized).pathname.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  if (first === undefined) {
    throw new CompetitorUrlError("The link has no profile name in it");
  }
  const handle = decodeURIComponent(first).replace(/^@/, "");
  if (RESERVED_SEGMENTS[platform].has(handle.toLowerCase())) {
    throw new CompetitorUrlError(
      "That is a link to a post or a page of the platform; paste the profile link instead",
    );
  }
  return profileOf(platform, handle);
}

function profileOf(platform: CompetitorPlatform, handle: string): CompetitorProfile {
  if (!COMPETITOR_HANDLE_RE.test(handle)) {
    throw new CompetitorUrlError("The profile name has characters the platform does not allow");
  }
  const profileUrl =
    platform === "instagram"
      ? `https://instagram.com/${handle}`
      : platform === "facebook"
        ? `https://facebook.com/${handle}`
        : `https://threads.net/@${handle}`;
  return { platform, handle, profileUrl };
}

/**
 * Whether the studio agent may download `url` as a public video of `platform`: an https link on
 * the platform's own hosts that points at a single post, never a profile, search or login page.
 */
export function isPublicVideoUrl(url: string, platform: CompetitorPlatform): boolean {
  const { URL } = globalThis as unknown as {
    URL: new (
      input: string,
    ) => {
      protocol: string;
      hostname: string;
      pathname: string;
      username: string;
      password: string;
      port: string;
    };
  };
  let parsed: InstanceType<typeof URL>;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    return false;
  }
  if (detectReferencePlatform(parsed.hostname) !== platform) {
    return false;
  }
  const path = parsed.pathname;
  switch (platform) {
    case "instagram":
      return /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/.test(path);
    case "facebook":
      return (
        /^\/reel\/\d+\/?$/.test(path) ||
        /^\/watch\/?$/.test(path) ||
        /^\/[A-Za-z0-9.]+\/videos\/(?:[^/]+\/)?\d+\/?$/.test(path) ||
        /^\/share\/[rv]\/[A-Za-z0-9]+\/?$/.test(path) ||
        parsed.hostname.endsWith("fb.watch")
      );
    case "threads":
      return /^\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/?$/.test(path);
  }
}

const TAG_PLATFORM: Readonly<Record<CompetitorPlatform, string>> = {
  instagram: "ig",
  facebook: "fb",
  threads: "th",
};

/**
 * The knowledge-base tag of one competitor's entries, such as `competitor-ig-nasa`: lowercase, with
 * every other character turned into `-`, cut to the tag limit of 40 characters.
 */
export function competitorTag(platform: CompetitorPlatform, handle: string): string {
  const slug = handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `competitor-${TAG_PLATFORM[platform]}-${slug || "x"}`.slice(0, 40).replace(/-+$/, "");
}
