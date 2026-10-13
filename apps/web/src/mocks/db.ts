import {
  type AccessToken,
  type AssetDetail,
  type Channel,
  type ContentItem,
  type ContentVersion,
  type Conversation,
  type Device,
  type Format,
  type FormatVersion,
  type JobSummary,
  type KbEntryDetail,
  type LiveEvent,
  type Me,
  type Message,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_TTL_MS,
  type PairingCode,
  type PasswordTokenPurpose,
  type Project,
  type Review,
  type ScheduledPost,
  type Series,
  type SeriesChannels,
  TOKEN_PREFIXES,
  TOKEN_SECRET_LENGTH,
  type UserSummary,
} from "@loomcast/contracts";

/** A set-password link the mock API handed out. The real API keeps only a hash of the token. */
export interface MockPasswordToken {
  token: string;
  userId: string;
  purpose: PasswordTokenPurpose;
  expiresAt: string;
  usedAt: string | null;
}

/** In-memory state behind the mock API. Tests build one per case; the browser keeps one per tab. */
export interface MockDb {
  user: Me;
  password: string;
  signedIn: boolean;
  projects: Project[];
  devices: Device[];
  /** Access tokens as listed; secrets are never kept. */
  tokens: AccessToken[];
  /** Pairing codes handed out, newest last. */
  pairingCodes: PairingCode[];
  /**
   * Mock mode only: a studio agent "pairs" this long after a code is created,
   * so the pairing dialog can be seen closing. Tests leave it unset.
   */
  autoPairAfterMs?: number;
  conversations: Conversation[];
  messages: Message[];
  jobs: JobSummary[];
  /** Knowledge-base entries of every project, with their reference details. */
  kbEntries: KbEntryDetail[];
  /** Everyone else in the workspace, as the owner lists them; the signed-in user is `user`. */
  members: UserSummary[];
  /** Set-password links handed out, newest last. */
  passwordTokens: MockPasswordToken[];
  /** Series of every project. */
  series: Series[];
  /** Content items of every project. */
  contentItems: ContentItem[];
  /** Every version of every content item. */
  contentVersions: ContentVersion[];
  /** Stored files: voice takes, renders and posters. Versions' assets are filled in on first read. */
  assets: AssetDetail[];
  /** Review decisions on content items, newest last. */
  reviews: Review[];
  /** Formats of every project, with their current version. */
  formats: Format[];
  /** Every version of every format. */
  formatVersions: FormatVersion[];
  /** Publishing channels (global, like the real API). */
  channels: Channel[];
  /** The channels each series publishes to. */
  seriesChannels: SeriesChannels[];
  /** Scheduled posts of every item on every channel. */
  posts: ScheduledPost[];
  /**
   * Answers posted messages like a studio agent would: dispatch, tool
   * activity, streamed text, the stored reply. Off in tests, which drive the
   * live events themselves; on in mock mode.
   */
  simulateProducer?: boolean;
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
    tokens: [],
    pairingCodes: [],
    conversations: [],
    messages: [],
    jobs: [],
    kbEntries: [],
    members: [],
    passwordTokens: [],
    series: [],
    contentItems: [],
    contentVersions: [],
    assets: [],
    reviews: [],
    formats: [],
    formatVersions: [],
    channels: [],
    seriesChannels: [],
    posts: [],
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

function randomFrom(alphabet: string, length: number): string {
  return Array.from(
    { length },
    () => alphabet[Math.floor(Math.random() * alphabet.length)] ?? alphabet[0],
  ).join("");
}

/** A fresh `XXXX-XXXX` code, valid for ten minutes like the real one. */
export function mockPairingCode(now = Date.now()): PairingCode {
  return {
    code: `${randomFrom(PAIRING_CODE_ALPHABET, 4)}-${randomFrom(PAIRING_CODE_ALPHABET, 4)}`,
    expiresAt: new Date(now + PAIRING_CODE_TTL_MS).toISOString(),
  };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A secret shaped like a real MCP token. */
export function mockTokenSecret(): string {
  return `${TOKEN_PREFIXES.mcp}${randomFrom(BASE62, TOKEN_SECRET_LENGTH)}`;
}

/** The listed part of a token: its first characters, as the API stores them. */
export function tokenPrefix(secret: string): string {
  return secret.slice(0, TOKEN_PREFIXES.mcp.length + 4);
}

export function mockToken(
  overrides: Partial<AccessToken> & Pick<AccessToken, "name" | "scopes">,
): AccessToken {
  return {
    id: mockId(),
    kind: "mcp",
    prefix: tokenPrefix(mockTokenSecret()),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/**
 * What the server does when a studio agent pairs and connects: the device is
 * added and a `device.status` event says it is online.
 */
export function pairMockDevice(db: MockDb, overrides: Partial<Device> = {}): Device {
  const at = new Date().toISOString();
  const device: Device = {
    id: mockId(),
    name: "Studio MacBook Pro",
    platform: "darwin-arm64",
    agentVersion: "0.1.0",
    online: true,
    lastSeenAt: at,
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
  db.devices.push(device);
  publish(db, {
    type: "device.status",
    payload: { deviceId: device.id, online: device.online, lastSeenAt: device.lastSeenAt },
  });
  return device;
}

/** Demo content for `pnpm --filter @loomcast/web dev:mock`. */
export function demoSeed(now = Date.now()): Partial<Omit<MockDb, "listeners">> {
  return {
    autoPairAfterMs: 30_000,
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
      {
        id: mockId(),
        name: "Old iMac",
        platform: "darwin-x64",
        agentVersion: "0.0.9",
        online: false,
        lastSeenAt: minutesAgo(3 * 24 * 60, now),
        createdAt: minutesAgo(30 * 24 * 60, now),
        revokedAt: null,
      },
    ],
    tokens: [
      mockToken({
        name: "Editor on my laptop",
        scopes: ["mcp:read", "mcp:write"],
        createdAt: minutesAgo(6 * 24 * 60, now),
        lastUsedAt: minutesAgo(25, now),
      }),
      mockToken({
        name: "Research notebook",
        scopes: ["mcp:read"],
        createdAt: minutesAgo(2 * 24 * 60, now),
      }),
    ],
  };
}
