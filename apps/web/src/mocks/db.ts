import type { Device, LiveEvent, Me, Project } from "@loomcast/contracts";

/** In-memory state behind the mock API. Tests build one per case; the browser keeps one per tab. */
export interface MockDb {
  user: Me;
  password: string;
  signedIn: boolean;
  projects: Project[];
  devices: Device[];
  /** Live stream clients; the mock API publishes to them like the real bus. */
  listeners: Set<(event: LiveEvent) => void>;
  /** Called when a login or logout changes the session. */
  onSessionChange?: (signedIn: boolean) => void;
}

export const MOCK_USER: Me = {
  id: "4f6d1c2a-8b3e-4a5f-9c7d-1e2f3a4b5c6d",
  email: "owner@loomcast.test",
  name: "Nadia Perera",
  role: "owner",
  createdAt: "2026-09-01T08:00:00.000Z",
  lastLoginAt: "2026-10-12T08:00:00.000Z",
};

export const MOCK_PASSWORD = "loomcast-demo-password";

export function createMockDb(seed: Partial<Omit<MockDb, "listeners">> = {}): MockDb {
  return {
    user: MOCK_USER,
    password: MOCK_PASSWORD,
    signedIn: false,
    projects: [],
    devices: [],
    ...seed,
    listeners: new Set(),
  };
}

export function setSignedIn(db: MockDb, signedIn: boolean) {
  db.signedIn = signedIn;
  db.onSessionChange?.(signedIn);
}

export function publish(db: MockDb, event: LiveEvent) {
  for (const listener of db.listeners) listener(event);
}

function minutesAgo(minutes: number, now = Date.now()): string {
  return new Date(now - minutes * 60_000).toISOString();
}

let counter = 0;

/** A random v4-shaped id; good enough for mock rows. */
export function mockId(): string {
  counter += 1;
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${counter.toString(16).padStart(4, "0")}${hex(8)}`;
}

export function mockProject(overrides: Partial<Project> & Pick<Project, "name" | "slug">): Project {
  const at = overrides.updatedAt ?? new Date().toISOString();
  return {
    id: mockId(),
    description: null,
    status: "active",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    ...overrides,
  };
}

/** Demo content for `pnpm --filter @loomcast/web dev:mock`. */
export function demoSeed(now = Date.now()): Partial<Omit<MockDb, "listeners">> {
  return {
    projects: [
      mockProject({
        name: "Rust in 60 seconds",
        slug: "rust-in-60-seconds",
        description: "One Rust idea per short, explained with a single runnable example.",
        updatedAt: minutesAgo(12, now),
      }),
      mockProject({
        name: "Agents for small teams",
        slug: "agents-for-small-teams",
        updatedAt: minutesAgo(3 * 60, now),
      }),
      mockProject({
        name: "Postgres tricks you will use this week",
        slug: "postgres-tricks-you-will-use-this-week",
        updatedAt: minutesAgo(26 * 60, now),
      }),
      mockProject({
        name: "TypeScript type puzzles",
        slug: "typescript-type-puzzles",
        updatedAt: minutesAgo(4 * 24 * 60, now),
      }),
      mockProject({
        name: "Shell one-liners",
        slug: "shell-one-liners",
        status: "archived",
        archivedAt: minutesAgo(20 * 24 * 60, now),
        updatedAt: minutesAgo(20 * 24 * 60, now),
      }),
    ],
    devices: [
      {
        id: mockId(),
        name: "Studio Mac mini",
        platform: "darwin-arm64",
        agentVersion: "0.1.0",
        online: true,
        lastSeenAt: minutesAgo(0, now),
        createdAt: minutesAgo(9 * 24 * 60, now),
        revokedAt: null,
      },
    ],
  };
}
