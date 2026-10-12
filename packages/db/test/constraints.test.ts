import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobEvents, messages } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import { insertConversation, insertJob, insertProject, insertUser, PG, pgError } from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe("users.email", () => {
  it("rejects an email that is not stored in lowercase", async () => {
    const error = await pgError(insertUser(testDb.db, { email: "Ada@Example.com" }));
    expect(error).toEqual({ code: PG.checkViolation, constraint: "users_email_lowercase_ck" });
  });

  it("is unique", async () => {
    await insertUser(testDb.db, { email: "ada@example.com" });
    const error = await pgError(insertUser(testDb.db, { email: "ada@example.com" }));
    expect(error).toEqual({ code: PG.uniqueViolation, constraint: "users_email_uq" });
  });
});

describe("job_events (job_id, seq)", () => {
  it("is unique, and a replay with ON CONFLICT DO NOTHING inserts nothing", async () => {
    const user = await insertUser(testDb.db);
    const project = await insertProject(testDb.db, user.id);
    const job = await insertJob(testDb.db, { projectId: project.id, createdBy: user.id });
    const event = { jobId: job.id, seq: 1, kind: "log" as const, data: { level: "info" } };

    await testDb.db.insert(jobEvents).values(event);
    const error = await pgError(testDb.db.insert(jobEvents).values(event));
    expect(error).toEqual({ code: PG.uniqueViolation, constraint: "job_events_job_id_seq_uq" });

    const replayed = await testDb.db
      .insert(jobEvents)
      .values(event)
      .onConflictDoNothing({ target: [jobEvents.jobId, jobEvents.seq] })
      .returning({ id: jobEvents.id });
    expect(replayed).toEqual([]);

    await testDb.db.insert(jobEvents).values({ ...event, seq: 2 });
  });

  it("rejects sequence numbers below 1", async () => {
    const user = await insertUser(testDb.db);
    const project = await insertProject(testDb.db, user.id);
    const job = await insertJob(testDb.db, { projectId: project.id, createdBy: user.id });

    const error = await pgError(
      testDb.db.insert(jobEvents).values({ jobId: job.id, seq: 0, kind: "log", data: {} }),
    );
    expect(error).toEqual({ code: PG.checkViolation, constraint: "job_events_seq_ck" });
  });
});

describe("messages (conversation_id, client_message_id)", () => {
  async function setup() {
    const user = await insertUser(testDb.db);
    const project = await insertProject(testDb.db, user.id);
    const first = await insertConversation(testDb.db, project.id, user.id);
    const second = await insertConversation(testDb.db, project.id, user.id);
    const message = (conversationId: string, clientMessageId: string | null) => ({
      conversationId,
      role: "user" as const,
      authorUserId: user.id,
      clientMessageId,
      content: { text: "hello" },
    });
    return { first, second, message };
  }

  it("rejects a second message with the same client id in a conversation", async () => {
    const { first, message } = await setup();
    const clientMessageId = randomUUID();

    await testDb.db.insert(messages).values(message(first.id, clientMessageId));
    const error = await pgError(
      testDb.db.insert(messages).values(message(first.id, clientMessageId)),
    );
    expect(error).toEqual({
      code: PG.uniqueViolation,
      constraint: "messages_conversation_id_client_message_id_uq",
    });
  });

  it("allows the same client id in another conversation and any number without one", async () => {
    const { first, second, message } = await setup();
    const clientMessageId = randomUUID();

    await testDb.db
      .insert(messages)
      .values([
        message(first.id, clientMessageId),
        message(second.id, clientMessageId),
        message(first.id, null),
        message(first.id, null),
      ]);
  });
});
