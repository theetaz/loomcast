import type { Device, KbEntryDetail, Project } from "@loomcast/contracts";
import { createMockDb, MOCK_USER, type MockDb, mockId, mockProject } from "@/mocks/db";
import { mockKbEntry, mockReferenceDetail } from "@/mocks/kb";
import { server } from "./server";

export const PROJECT_SLUG = "rust-in-60-seconds";

export function onlineStudio(): Device {
  return {
    id: mockId(),
    name: "Studio Mac mini",
    platform: "darwin-arm64",
    agentVersion: "0.1.0",
    online: true,
    lastSeenAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt: null,
  };
}

/** A minute-precise timestamp `minutes` after a fixed start, so ordering is predictable. */
export function at(minutes: number): string {
  return new Date(Date.parse("2026-10-01T09:00:00.000Z") + minutes * 60_000).toISOString();
}

/**
 * A signed-in db with one project and a small knowledge base: a brainstorm, a note, two
 * decisions and a reference with a transcript.
 */
export function kbSetup(extra: (project: Project) => KbEntryDetail[] = () => []) {
  const project = mockProject({
    name: "Rust in 60 seconds",
    slug: PROJECT_SLUG,
    description: "One Rust idea per short.",
  });
  const entry = (minutes: number, overrides: Parameters<typeof mockKbEntry>[0]) =>
    mockKbEntry({
      createdBy: MOCK_USER.id,
      createdAt: at(minutes),
      updatedAt: at(minutes),
      ...overrides,
    });

  const brainstorm = entry(50, {
    projectId: project.id,
    kind: "brainstorm",
    title: "Hooks that open on the error",
    tags: ["hooks"],
    bodyMd: "Open on the **error**, not the fix.",
  });
  const note = entry(40, {
    projectId: project.id,
    kind: "note",
    title: "Recording checklist",
    tags: ["production"],
    bodyMd: "- Editor font at 22 pt",
  });
  const decision = entry(30, {
    projectId: project.id,
    kind: "decision",
    title: "Captions in the lower third",
    tags: ["captions"],
    bodyMd: "Captions sit in the lower third.",
    data: {
      decision: "Captions sit in the lower third.",
      rationale: "Clear of overlays.",
      status: "active",
    },
  });
  const reference = entry(20, {
    projectId: project.id,
    kind: "reference",
    title: "Instagram video by @fastrust",
    tags: ["hooks"],
    sourceUrl: "https://instagram.com/reel/abc/",
    bodyMd: "Error on screen first.",
    reference: mockReferenceDetail({
      url: "https://instagram.com/reel/abc/",
      platform: "instagram",
      author: "@fastrust",
      likedReason: "Error on screen first.",
      transcript:
        "[00:00] This line compiles.\n[00:02] Add one more line.\n[00:05] One owner per line.",
    }),
  });

  const db: MockDb = createMockDb({
    signedIn: true,
    projects: [project],
    devices: [onlineStudio()],
    kbEntries: [brainstorm, note, decision, reference],
  });
  db.kbEntries.push(...extra(project));
  return { db, project, brainstorm, note, decision, reference };
}

/** Records every request to the API, as method, path and query. */
export function recordRequests() {
  const requests: { method: string; path: string; query: URLSearchParams; body: unknown }[] = [];
  server.events.on("request:start", async ({ request }) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return;
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? undefined
        : await request
            .clone()
            .json()
            .catch(() => undefined);
    requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body });
  });
  return requests;
}
