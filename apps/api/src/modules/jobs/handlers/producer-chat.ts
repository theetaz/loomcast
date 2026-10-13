import { type Message, ProducerChatResultSchema } from "@loomcast/contracts";
import { conversations, type MessageRow, messages } from "@loomcast/db";
import { eq } from "drizzle-orm";
import type { EventBus } from "../../../lib/bus";
import { afterCommit } from "../../../lib/db";
import type { JobTypeHooks } from "../hooks";

/** A stored message as the web app sees it. */
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

/**
 * `producer.chat` side effects:
 * - every `assistant.message` event becomes an assistant message in the conversation (a turn may
 *   reply several times, around tool calls), published as `conversation.message.created`;
 * - on success the conversation keeps the producer session id and the studio agent that holds it,
 *   so the next turn resumes the same session on the same device.
 *
 * `result.finalText` repeats the last reply, which is already stored from its event, so it is not
 * stored again.
 */
export function createProducerChatHooks(deps: { bus: EventBus }): JobTypeHooks {
  const { bus } = deps;

  return {
    async onEvent(tx, job, event) {
      if (event.kind !== "assistant.message" || job.conversationId === null) {
        return;
      }
      const text = event.data.text;
      if (text.trim().length === 0) {
        return;
      }
      const [row] = await tx
        .insert(messages)
        .values({
          conversationId: job.conversationId,
          role: "assistant",
          jobId: job.id,
          content: { text },
        })
        .returning();
      if (row === undefined) {
        throw new Error("assistant message was not inserted");
      }
      await tx
        .update(conversations)
        .set({ lastMessageAt: row.createdAt })
        .where(eq(conversations.id, job.conversationId));
      const message = toMessage(row);
      afterCommit(tx, () =>
        bus.publish({ type: "conversation.message.created", payload: { message } }),
      );
    },

    async onSucceeded(tx, job, result) {
      if (job.conversationId === null) {
        return;
      }
      const parsed = ProducerChatResultSchema.parse(result);
      await tx
        .update(conversations)
        .set({ producerSessionId: parsed.sdkSessionId, deviceId: job.claimedByDevice })
        .where(eq(conversations.id, job.conversationId));
    },
  };
}
