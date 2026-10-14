/**
 * The guide's pages. Their text lives in `docs/guide/*.md` so it also reads on GitHub; the app
 * bundles it at build time. Screenshots are `docs/guide/images/*.png`, taken in mock mode by
 * `pnpm --filter @loomcast/e2e guide:screenshots`.
 */

export type GuideGroup = "Using Loomcast" | "Studio agent" | "Running Loomcast";

export const GUIDE_GROUPS: readonly GuideGroup[] = [
  "Using Loomcast",
  "Studio agent",
  "Running Loomcast",
];

export interface GuidePage {
  /** The file name without `.md`, also the page's address (`/guide/<slug>`). */
  slug: string;
  title: string;
  /** One line, shown on the guide's index and in the command palette. */
  summary: string;
  group: GuideGroup;
  keywords?: readonly string[];
  /** The page's markdown. */
  markdown: string;
}

type PageMeta = Omit<GuidePage, "markdown">;

/** Every page in reading order. A page whose file is missing is left out. */
const PAGES: readonly PageMeta[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "Signing in, finding your way around and how a video moves through Loomcast.",
    group: "Using Loomcast",
    keywords: ["intro", "overview", "login", "sign in", "navigation"],
  },
  {
    slug: "projects",
    title: "Projects and the producer chat",
    summary: "Create a project, describe it, and brief the producer in its chat.",
    group: "Using Loomcast",
    keywords: ["project", "chat", "producer", "conversation"],
  },
  {
    slug: "series-and-formats",
    title: "Series and formats",
    summary: "Group videos into a series with a cadence, channels and a reusable format.",
    group: "Using Loomcast",
    keywords: ["series", "format", "cadence", "template"],
  },
  {
    slug: "videos-and-review",
    title: "Videos, review and approvals",
    summary: "Follow a video from idea to render, review it, and approve or ask for changes.",
    group: "Using Loomcast",
    keywords: ["content", "pipeline", "review", "approve", "versions", "render", "library"],
  },
  {
    slug: "knowledge-base",
    title: "Knowledge base",
    summary: "Notes, references and rules the producer reads before it writes.",
    group: "Using Loomcast",
    keywords: ["kb", "knowledge", "reference", "notes", "brainstorm"],
  },
  {
    slug: "competitor-research",
    title: "Competitor research",
    summary: "Follow competitors' profiles and turn their best videos into a report.",
    group: "Using Loomcast",
    keywords: ["competitor", "scan", "report", "instagram", "facebook", "threads"],
  },
  {
    slug: "publishing",
    title: "Channels, calendar and publishing",
    summary: "Connect accounts, schedule approved videos and check what was posted.",
    group: "Using Loomcast",
    keywords: ["channels", "calendar", "schedule", "publish", "instagram", "facebook", "analytics"],
  },
  {
    slug: "settings",
    title: "Settings",
    summary: "Devices, access tokens, members, channels and the scheduler.",
    group: "Using Loomcast",
    keywords: ["settings", "members", "tokens", "mcp", "invite"],
  },
  {
    slug: "studio-agent",
    title: "Setting up the studio agent",
    summary: "Pair a Mac, keep the agent running in the background, and what it needs.",
    group: "Studio agent",
    keywords: ["agent", "pair", "device", "launchd", "service", "mac", "offline"],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    summary: "What to check, what to restart and where the logs are when something fails.",
    group: "Studio agent",
    keywords: ["debug", "error", "offline", "logs", "stuck", "failed", "restart"],
  },
  {
    slug: "operations",
    title: "Deploying and running the server",
    summary: "How a change reaches production, and how to check, restart or roll back the server.",
    group: "Running Loomcast",
    keywords: ["deploy", "release", "ci", "server", "docker", "rollback", "backup"],
  },
];

const sources = import.meta.glob<string>("../../../../../docs/guide/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const images = import.meta.glob<string>("../../../../../docs/guide/images/*.png", {
  query: "?url",
  import: "default",
  eager: true,
});

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const markdownBySlug = new Map(
  Object.entries(sources).map(([path, text]) => [fileName(path).replace(/\.md$/, ""), text]),
);

const imageByName = new Map(Object.entries(images).map(([path, url]) => [fileName(path), url]));

export const guidePages: readonly GuidePage[] = PAGES.flatMap((page) => {
  const markdown = markdownBySlug.get(page.slug);
  return markdown === undefined ? [] : [{ ...page, markdown }];
});

export function guidePage(slug: string): GuidePage | undefined {
  return guidePages.find((page) => page.slug === slug);
}

/**
 * The bundled address of a screenshot a page links as `images/<name>.png`, or undefined for any
 * other source: the guide shows only its own images.
 */
export function guideImageUrl(src: string): string | undefined {
  const match = /^(?:\.\/)?images\/([\w.-]+\.png)$/.exec(src);
  return match?.[1] === undefined ? undefined : imageByName.get(match[1]);
}

/** The guide page a link such as `studio-agent.md#pairing` points at, or undefined. */
export function guideLinkTarget(href: string): { slug: string; hash?: string } | undefined {
  const match = /^(?:\.\/)?([\w-]+)\.md(?:#([\w-]+))?$/.exec(href);
  if (match?.[1] === undefined || guidePage(match[1]) === undefined) return undefined;
  return match[2] === undefined ? { slug: match[1] } : { slug: match[1], hash: match[2] };
}

/** The markdown without its `# Title` line: the page header shows the title. */
export function guideBody(markdown: string): string {
  return markdown.replace(/^#\s+.*\n+/, "");
}

/** A heading's anchor, as GitHub makes it. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}
