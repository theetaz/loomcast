import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_FORMAT_RULES,
  OAUTH_CONNECTION_TTL_MS,
  OAUTH_STATE_TTL_MS,
  type SkillFile,
  type SkillKind,
  skillChecksumInput,
} from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../src/client";
import {
  type AssetMeta,
  CHANNEL_SECRET_NONCE_BYTES,
  CHANNEL_SECRET_TAG_BYTES,
  channels,
  contentItems,
  contentVersions,
  conversations,
  formats,
  formatVersions,
  jobs,
  kbEntries,
  type NewApiTokenRow,
  type NewAssetRow,
  type NewChannelRow,
  type NewContentItemRow,
  type NewJobRow,
  type NewKbEntryRow,
  type NewOAuthConnectionRow,
  type NewOAuthStateRow,
  type NewScheduledPostRow,
  type NewUserRow,
  oauthConnections,
  oauthStates,
  scheduledPosts,
  series,
  skills,
  skillVersions,
  users,
  workspaces,
} from "../src/schema";

export async function insertUser(db: Database, overrides: Partial<NewUserRow> = {}) {
  const [user] = await db
    .insert(users)
    .values({
      email: `user-${randomUUID()}@example.com`,
      name: "Test User",
      passwordHash: "not-a-real-hash",
      role: "admin",
      ...overrides,
    })
    .returning();
  if (user === undefined) throw new Error("user was not inserted");
  return user;
}

export async function insertWorkspace(db: Database, createdBy: string) {
  const [workspace] = await db
    .insert(workspaces)
    .values({ slug: `workspace-${randomUUID()}`, name: "Test Workspace", createdBy })
    .returning();
  if (workspace === undefined) throw new Error("workspace was not inserted");
  return workspace;
}

export async function insertConversation(db: Database, workspaceId: string, createdBy: string) {
  const [conversation] = await db
    .insert(conversations)
    .values({ workspaceId, createdBy })
    .returning();
  if (conversation === undefined) throw new Error("conversation was not inserted");
  return conversation;
}

type JobFixture = Pick<NewJobRow, "workspaceId" | "createdBy"> & Partial<NewJobRow>;

export function jobValues(values: JobFixture): NewJobRow {
  return { type: "system.ping", payload: {}, ...values };
}

export async function insertJob(db: Database, values: JobFixture) {
  const [job] = await db.insert(jobs).values(jobValues(values)).returning();
  if (job === undefined) throw new Error("job was not inserted");
  return job;
}

/** A random sha256 hex digest, standing in for the stored hash of a secret. */
export function randomHash(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

type KbEntryFixture = Pick<NewKbEntryRow, "workspaceId"> & Partial<NewKbEntryRow>;

export async function insertKbEntry(db: Database, values: KbEntryFixture) {
  const [entry] = await db
    .insert(kbEntries)
    .values({ kind: "note", title: "Untitled entry", createdVia: "ui", ...values })
    .returning();
  if (entry === undefined) throw new Error("kb entry was not inserted");
  return entry;
}

type ApiTokenFixture = Pick<NewApiTokenRow, "userId" | "kind"> & Partial<NewApiTokenRow>;

/** Inserts a token row. The hash and prefix are random; no secret is involved. */
export function apiTokenValues(values: ApiTokenFixture): NewApiTokenRow {
  return {
    name: "test token",
    tokenHash: randomHash(),
    prefix: randomUUID().slice(0, 8),
    ...values,
  };
}

export interface PgErrorInfo {
  code: string | undefined;
  constraint: string | undefined;
}

/**
 * Awaits a query that must fail and returns the Postgres error code and constraint. Drizzle wraps
 * driver errors in `DrizzleQueryError`, so the driver error is read from `cause` when present.
 */
export async function pgError(query: PromiseLike<unknown>): Promise<PgErrorInfo> {
  try {
    await query;
  } catch (error) {
    const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const fields = source as { code?: string; constraint?: string };
    return { code: fields.code, constraint: fields.constraint };
  }
  throw new Error("expected the query to fail");
}

/** Postgres SQLSTATE codes used in assertions. */
export const PG = {
  uniqueViolation: "23505",
  checkViolation: "23514",
  notNullViolation: "23502",
  foreignKeyViolation: "23503",
} as const;

/** A database or a transaction: anything with the query builders. */
type Writer = Pick<Database, "insert">;

/** Inserts a format and its version 1 in one transaction, as the API does. */
export async function insertFormat(db: Database, workspaceId: string, createdBy?: string) {
  const formatId = randomUUID();
  const versionId = randomUUID();
  return db.transaction(async (tx) => {
    const [format] = await tx
      .insert(formats)
      .values({
        id: formatId,
        workspaceId,
        name: "Test Format",
        slug: `format-${formatId}`,
        currentVersionId: versionId,
      })
      .returning();
    const [version] = await tx
      .insert(formatVersions)
      .values({
        id: versionId,
        formatId,
        versionNo: 1,
        rules: structuredClone(DEFAULT_FORMAT_RULES),
        createdBy,
      })
      .returning();
    if (format === undefined || version === undefined) throw new Error("format was not inserted");
    return { format, version };
  });
}

type ContentItemFixture = Pick<NewContentItemRow, "workspaceId"> &
  Partial<Omit<NewContentItemRow, "id" | "currentVersionId">>;

/** Inserts a content item and its version 1 (the bare idea) through `db`, which may be a tx. */
export async function insertItemWith(db: Writer, values: ContentItemFixture) {
  const itemId = randomUUID();
  const versionId = randomUUID();
  const [item] = await db
    .insert(contentItems)
    .values({
      title: "Test Item",
      createdVia: "ui",
      ...values,
      id: itemId,
      currentVersionId: versionId,
    })
    .returning();
  const [version] = await db
    .insert(contentVersions)
    .values({ id: versionId, itemId, versionNo: 1, stage: "idea", createdVia: "system" })
    .returning();
  if (item === undefined || version === undefined) throw new Error("item was not inserted");
  return { item, version };
}

/** Inserts a content item and its version 1 in one transaction. */
export function insertContentItem(db: Database, values: ContentItemFixture) {
  return db.transaction((tx) => insertItemWith(tx, values));
}

// Rows for a database of an earlier release, before projects were renamed to workspaces
// (0017): the current schema names tables and columns that do not exist there yet, so these
// write plain SQL with the old names (`projects`, `project_id`) and only the columns of the time.

/** A row of `projects`, the table that became `workspaces`. */
export async function insertLegacyWorkspace(
  db: Database,
  createdBy: string,
  values: { slug?: string; name?: string } = {},
) {
  const slug = values.slug ?? `project-${randomUUID()}`;
  const name = values.name ?? "Test Project";
  const result = await db.execute<{ id: string }>(
    sql`insert into projects (slug, name, created_by) values (${slug}, ${name}, ${createdBy})
        returning id`,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("project was not inserted");
  return { id, slug, name };
}

/** `insertFormat` with the old names: a format and its version 1 in one transaction. */
export function insertLegacyFormat(db: Database, projectId: string, createdBy?: string) {
  const formatId = randomUUID();
  const versionId = randomUUID();
  const rules = JSON.stringify(DEFAULT_FORMAT_RULES);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`insert into formats (id, project_id, name, slug, current_version_id)
          values (${formatId}, ${projectId}, 'Test Format', ${`format-${formatId}`}, ${versionId})`,
    );
    await tx.execute(
      sql`insert into format_versions (id, format_id, version_no, rules, created_by)
          values (${versionId}, ${formatId}, 1, ${rules}::jsonb, ${createdBy ?? null})`,
    );
    return { format: { id: formatId }, version: { id: versionId } };
  });
}

/** `insertSeries` with the old names: a series of a new format in `projectId`. */
export async function insertLegacySeries(
  db: Database,
  projectId: string,
  values: { createdBy?: string; slug?: string } = {},
) {
  const { format } = await insertLegacyFormat(db, projectId, values.createdBy);
  const slug = values.slug ?? `series-${randomUUID()}`;
  const result = await db.execute<{ id: string }>(
    sql`insert into series (project_id, name, slug, format_id)
        values (${projectId}, 'Test Series', ${slug}, ${format.id}) returning id`,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("series was not inserted");
  return { id, formatId: format.id };
}

interface LegacyContentItemFixture {
  projectId: string;
  seriesId?: string;
  createdBy?: string;
  targetAt?: Date;
}

/**
 * `insertContentItem` with the old names: the item and its version 1 (the bare idea), naming only
 * the columns they had before the post formats (0015).
 */
export function insertLegacyContentItem(db: Database, values: LegacyContentItemFixture) {
  return db.transaction(async (tx) => {
    const itemId = randomUUID();
    const versionId = randomUUID();
    await tx.execute(
      sql`insert into content_items (id, project_id, series_id, title, current_version_id,
                                     target_at, created_via, created_by)
          values (${itemId}, ${values.projectId}, ${values.seriesId ?? null}, 'Test Item',
                  ${versionId}, ${values.targetAt?.toISOString() ?? null}, 'ui',
                  ${values.createdBy ?? null})`,
    );
    await tx.execute(
      sql`insert into content_versions (id, item_id, version_no, stage, created_via)
          values (${versionId}, ${itemId}, 1, 'idea', 'system')`,
    );
    return { item: { id: itemId }, version: { id: versionId } };
  });
}

/** Inserts an asset in `projectId`; the table's other columns are unchanged since 0007. */
export function insertLegacyAsset(
  db: Database,
  projectId: string,
  values: Partial<NewAssetRow> = {},
) {
  const row = assetValues({ ...values, workspaceId: projectId });
  return db.execute<{ id: string }>(
    sql`insert into assets (project_id, item_id, kind, status, bucket, storage_key, filename,
                            mime, bytes, sha256, meta)
        values (${row.workspaceId}, ${row.itemId ?? null}, ${row.kind}, ${row.status ?? "pending"},
                ${row.bucket}, ${row.storageKey}, ${row.filename}, ${row.mime}, ${row.bytes},
                ${row.sha256}, ${JSON.stringify(row.meta ?? {})}::jsonb)
        returning id`,
  );
}

type AssetFixture = Pick<NewAssetRow, "workspaceId"> & Partial<NewAssetRow>;

/** Asset values with a random storage key and SHA-256 (as stored: lowercase hex). */
export function assetValues(values: AssetFixture): NewAssetRow {
  const meta: AssetMeta = {};
  return {
    kind: "voice",
    bucket: "loomcast-media",
    storageKey: `test/${randomUUID()}`,
    filename: "take.mp3",
    mime: "audio/mpeg",
    bytes: 1024,
    sha256: randomHash(),
    meta,
    ...values,
  };
}

/** Skill files and their checksum, as the server computes it. */
export function skillFiles(label: string): { files: SkillFile[]; checksum: string } {
  const files: SkillFile[] = [
    { path: "SKILL.md", content: `# ${label}\n` },
    { path: "skill.json", content: JSON.stringify({ name: label, kind: "skill" }) },
  ];
  const checksum = createHash("sha256").update(skillChecksumInput(files), "utf8").digest("hex");
  return { files, checksum };
}

/** Publishes a skill with its version 1 in one transaction. */
export async function insertSkill(db: Database, name: string, kind: SkillKind = "skill") {
  const skillId = randomUUID();
  const versionId = randomUUID();
  const { files, checksum } = skillFiles(name);
  return db.transaction(async (tx) => {
    const [skill] = await tx
      .insert(skills)
      .values({ id: skillId, name, kind, currentVersionId: versionId })
      .returning();
    const [version] = await tx
      .insert(skillVersions)
      .values({ id: versionId, skillId, version: 1, files, checksum })
      .returning();
    if (skill === undefined || version === undefined) throw new Error("skill was not inserted");
    return { skill, version };
  });
}

/**
 * Stored channel credentials as the token vault writes them: random bytes standing in for the
 * AES-GCM ciphertext (with its tag) and nonce. No secret is involved.
 */
export function sealedSecret(keyVersion = 1) {
  return {
    secretCiphertext: randomBytes(CHANNEL_SECRET_TAG_BYTES + 32),
    secretNonce: randomBytes(CHANNEL_SECRET_NONCE_BYTES),
    keyVersion,
  };
}

type ChannelFixture = Pick<NewChannelRow, "workspaceId"> & Partial<NewChannelRow>;

/** A planning channel (no credentials, `disconnected`) of `workspaceId` unless overridden. */
export function channelValues(values: ChannelFixture): NewChannelRow {
  return { platform: "instagram", displayName: "Test Channel", ...values };
}

export async function insertChannel(db: Writer, values: ChannelFixture) {
  const [channel] = await db.insert(channels).values(channelValues(values)).returning();
  if (channel === undefined) throw new Error("channel was not inserted");
  return channel;
}

/** A connected, active channel with a random external id. */
export function insertActiveChannel(db: Writer, values: ChannelFixture) {
  return insertChannel(db, {
    externalId: `acct-${randomUUID()}`,
    status: "active",
    ...sealedSecret(),
    ...values,
  });
}

/** Inserts a series of a new format in `workspaceId`. */
export async function insertSeries(db: Database, workspaceId: string, createdBy?: string) {
  const { format } = await insertFormat(db, workspaceId, createdBy);
  const [created] = await db
    .insert(series)
    .values({
      workspaceId,
      name: "Test Series",
      slug: `series-${randomUUID()}`,
      formatId: format.id,
    })
    .returning();
  if (created === undefined) throw new Error("series was not inserted");
  return created;
}

type PostFixture = Pick<NewScheduledPostRow, "itemId" | "channelId"> & Partial<NewScheduledPostRow>;

export function postValues(values: PostFixture): NewScheduledPostRow {
  return { scheduledAt: new Date(Date.now() + 60 * 60_000), ...values };
}

export async function insertPost(db: Writer, values: PostFixture) {
  const [post] = await db.insert(scheduledPosts).values(postValues(values)).returning();
  if (post === undefined) throw new Error("post was not inserted");
  return post;
}

/**
 * A sign-in state as `oauth.start` makes one: random bytes, of which only the SHA-256 is stored.
 * Both are generated here; no secret is involved.
 */
export function oauthState() {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: createHash("sha256").update(value).digest("hex") };
}

/** A sealed PKCE verifier as the token vault writes it: random bytes, no secret involved. */
export function sealedPkce(keyVersion = 1) {
  const { secretCiphertext, secretNonce } = sealedSecret(keyVersion);
  return { pkceCiphertext: secretCiphertext, pkceNonce: secretNonce, keyVersion };
}

type OAuthStateFixture = Pick<NewOAuthStateRow, "userId"> & Partial<NewOAuthStateRow>;

export async function insertOAuthState(db: Writer, values: OAuthStateFixture) {
  const [state] = await db
    .insert(oauthStates)
    .values({
      stateHash: oauthState().hash,
      provider: "meta",
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      ...values,
    })
    .returning();
  if (state === undefined) throw new Error("oauth state was not inserted");
  return state;
}

type OAuthConnectionFixture = Pick<NewOAuthConnectionRow, "userId"> &
  Partial<NewOAuthConnectionRow>;

/** A pending connection with a sealed secret and one Facebook Page candidate. */
export async function insertOAuthConnection(db: Writer, values: OAuthConnectionFixture) {
  const pageId = `page-${randomUUID()}`;
  const [connection] = await db
    .insert(oauthConnections)
    .values({
      provider: "meta",
      ...sealedSecret(),
      candidates: [
        {
          id: `facebook:${pageId}`,
          platform: "facebook",
          externalId: pageId,
          name: "Test Page",
          parentId: null,
        },
      ],
      expiresAt: new Date(Date.now() + OAUTH_CONNECTION_TTL_MS),
      ...values,
    })
    .returning();
  if (connection === undefined) throw new Error("oauth connection was not inserted");
  return connection;
}
