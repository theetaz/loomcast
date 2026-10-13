import {
  type Conversation,
  type CreateConversation,
  type CursorPage,
  DEFAULT_PAGE_LIMIT,
  IdSchema,
  type Message,
  type PostMessageRequest,
} from "@loomcast/contracts";
import {
  type ConversationRow,
  conversations,
  type Database,
  type JobRow,
  type MessageRow,
  messages,
  projects,
} from "@loomcast/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, transaction } from "../../lib/db";
import { conflict, notFound, validationFailed } from "../../lib/errors";
import type { JobsService } from "../jobs/service";

export interface ConversationsServiceDeps {
  db: Database;
  bus: EventBus;
  jobs: JobsService;
}

export interface ListMessagesOptions {
  /** `nextCursor` of the previous page. */
  cursor?: string;
  limit?: number;
}

export interface PostMessageInput extends PostMessageRequest {
  conversationId: string;
  userId: string;
}

export interface PostMessageResult {
  message: MessageRow;
  job: JobRow;
  /** False when `clientMessageId` was posted before and the stored message was returned. */
  created: boolean;
}

export interface ConversationsService {
  /** Conversations of a project, most recent activity first. Null when the project is unknown. */
  list(projectId: string): Promise<ConversationRow[] | null>;
  /** Starts a conversation. 404 for an unknown project, 409 for an archived one. */
  create(projectId: string, input: CreateConversation, userId: string): Promise<ConversationRow>;
  get(id: string, executor?: Executor): Promise<ConversationRow | null>;
  /**
   * One page of messages, oldest first. Pass the returned `nextCursor` to read the following
   * page; on the last page it is null, and its last message id can later be passed as `cursor`
   * to fetch only what arrived since. Null when the conversation is unknown.
   */
  listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<CursorPage<MessageRow> | null>;
  /**
   * Stores the user's message and enqueues the `producer.chat` job that answers it, in one
   * transaction. The job resumes the conversation's producer session and is pinned to the studio
   * agent that holds it. Publishes `conversation.message.created` once committed. Repeating a
   * `clientMessageId` returns the stored message and its job without enqueuing again.
   */
  postMessage(input: PostMessageInput): Promise<PostMessageResult>;
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    deviceId: row.deviceId,
    contentItemId: row.contentItemId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    authorUserId: row.authorUserId,
    jobId: row.jobId,
    clientMessageId: row.clientMessageId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

const archivedProject = () =>
  conflict("The project is archived. Restore it before adding to it.", { reason: "archived" });

export function createConversationsService(deps: ConversationsServiceDeps): ConversationsService {
  const { db, bus, jobs } = deps;

  async function projectStatus(executor: Executor, projectId: string) {
    if (!IdSchema.safeParse(projectId).success) {
      return null;
    }
    const [row] = await executor
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row?.status ?? null;
  }

  async function get(id: string, executor: Executor = db) {
    if (!IdSchema.safeParse(id).success) {
      return null;
    }
    const [row] = await executor
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    return row ?? null;
  }

  return {
    async list(projectId) {
      if ((await projectStatus(db, projectId)) === null) {
        return null;
      }
      // Same order as the (project_id, last_message_at DESC NULLS LAST) index.
      return db
        .select()
        .from(conversations)
        .where(eq(conversations.projectId, projectId))
        .orderBy(
          sql`${conversations.lastMessageAt} desc nulls last`,
          desc(conversations.createdAt),
          desc(conversations.id),
        );
    },

    async create(projectId, input, userId) {
      const status = await projectStatus(db, projectId);
      if (status === null) {
        throw notFound("Project not found.");
      }
      if (status === "archived") {
        throw archivedProject();
      }
      const [row] = await db
        .insert(conversations)
        .values({ projectId, title: input.title ?? null, createdBy: userId })
        .returning();
      if (row === undefined) {
        throw new Error("conversation was not inserted");
      }
      return row;
    },

    get,

    async listMessages(conversationId, options = {}) {
      if ((await get(conversationId)) === null) {
        return null;
      }
      const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
      const conditions = [eq(messages.conversationId, conversationId)];
      if (options.cursor !== undefined) {
        const cursor = options.cursor;
        const anchor = IdSchema.safeParse(cursor).success
          ? await db
              .select({ id: messages.id })
              .from(messages)
              .where(and(eq(messages.id, cursor), eq(messages.conversationId, conversationId)))
              .limit(1)
          : [];
        if (anchor.length === 0) {
          throw validationFailed([{ path: "cursor", message: "Unknown cursor" }]);
        }
        // Compared in SQL: created_at has microseconds, which a JS Date would round away.
        conditions.push(
          sql`(${messages.createdAt}, ${messages.id}) > (select m.created_at, m.id from ${messages} m where m.id = ${cursor})`,
        );
      }
      const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
      return { items, nextCursor };
    },

    async postMessage(input) {
      return transaction(db, async (tx) => {
        // Locking the conversation serialises posts to it, so each job sees the session and the
        // device the previous turn left behind.
        const [conversation] = await tx
          .select({
            id: conversations.id,
            projectId: conversations.projectId,
            producerSessionId: conversations.producerSessionId,
            deviceId: conversations.deviceId,
            contentItemId: conversations.contentItemId,
            projectStatus: projects.status,
          })
          .from(conversations)
          .innerJoin(projects, eq(projects.id, conversations.projectId))
          .where(eq(conversations.id, input.conversationId))
          .limit(1)
          .for("update", { of: conversations });
        if (conversation === undefined) {
          throw notFound("Conversation not found.");
        }

        const [inserted] = await tx
          .insert(messages)
          .values({
            conversationId: conversation.id,
            role: "user",
            authorUserId: input.userId,
            clientMessageId: input.clientMessageId,
            content: { text: input.text },
          })
          .onConflictDoNothing({ target: [messages.conversationId, messages.clientMessageId] })
          .returning();

        if (inserted === undefined) {
          const [existing] = await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, conversation.id),
                eq(messages.clientMessageId, input.clientMessageId),
              ),
            )
            .limit(1);
          const job = existing?.jobId == null ? null : await jobs.get(existing.jobId, tx);
          if (existing === undefined || job === null) {
            throw conflict("This message was already posted.", { field: "clientMessageId" });
          }
          return { message: existing, job, created: false };
        }

        if (conversation.projectStatus === "archived") {
          throw archivedProject();
        }

        const { job } = await jobs.enqueue(tx, {
          type: "producer.chat",
          payload: {
            conversationId: conversation.id,
            projectId: conversation.projectId,
            messageId: inserted.id,
            text: input.text,
            ...(conversation.producerSessionId === null
              ? {}
              : { producerSessionId: conversation.producerSessionId }),
            // An item's own conversation tells the producer session which item it is about.
            ...(conversation.contentItemId === null
              ? {}
              : { contentItemId: conversation.contentItemId }),
          },
          projectId: conversation.projectId,
          conversationId: conversation.id,
          deviceAffinity: conversation.deviceId,
          createdBy: input.userId,
        });

        // The user message points at the job that answers it, so a repeated post finds the job.
        const [message] = await tx
          .update(messages)
          .set({ jobId: job.id })
          .where(eq(messages.id, inserted.id))
          .returning();
        if (message === undefined) {
          throw new Error("message vanished inside its transaction");
        }
        await tx
          .update(conversations)
          .set({ lastMessageAt: message.createdAt })
          .where(eq(conversations.id, conversation.id));

        const payload = { message: toMessage(message) };
        afterCommit(tx, () => bus.publish({ type: "conversation.message.created", payload }));
        return { message, job, created: true };
      });
    },
  };
}
