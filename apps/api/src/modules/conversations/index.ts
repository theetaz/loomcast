import {
  CreateConversationSchema,
  CursorPageQuerySchema,
  PostMessageRequestSchema,
  type PostMessageResponse,
  routes,
} from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { toJobSummary } from "../jobs/service";
import { createConversationsService, toConversation, toMessage } from "./service";

export {
  type ConversationsService,
  type ConversationsServiceDeps,
  createConversationsService,
  type ListMessagesOptions,
  type PostMessageInput,
  type PostMessageResult,
  toConversation,
  toMessage,
} from "./service";

const conversationNotFound = () => notFound("Conversation not found.");

/**
 * Conversations of a workspace and their messages. Posting a message stores it and enqueues the
 * `producer.chat` job that answers it; the job dispatcher delivers the job to a studio agent.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const service = createConversationsService(deps);
  const router = new Hono<AppEnv>();

  router.get(routes["conversations.list"].path, async (c) => {
    currentUser(c);
    const rows = await service.list(idParam(c, "workspaceId"));
    if (rows === null) {
      throw notFound("Workspace not found.");
    }
    return c.json({ items: rows.map(toConversation) }, 200);
  });

  router.post(routes["conversations.create"].path, async (c) => {
    const user = currentUser(c);
    const workspaceId = idParam(c, "workspaceId");
    const input = await readJson(c, CreateConversationSchema);
    const row = await service.create(workspaceId, input, user.id);
    return c.json(toConversation(row), 201);
  });

  router.get(routes["conversations.get"].path, async (c) => {
    currentUser(c);
    const row = await service.get(idParam(c));
    if (row === null) {
      throw conversationNotFound();
    }
    return c.json(toConversation(row), 200);
  });

  router.get(routes["messages.list"].path, async (c) => {
    currentUser(c);
    const id = idParam(c);
    const query = CursorPageQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const page = await service.listMessages(id, query.data);
    if (page === null) {
      throw conversationNotFound();
    }
    return c.json({ items: page.items.map(toMessage), nextCursor: page.nextCursor }, 200);
  });

  router.post(routes["messages.post"].path, async (c) => {
    const user = currentUser(c);
    const conversationId = idParam(c);
    const input = await readJson(c, PostMessageRequestSchema);
    const result = await service.postMessage({ ...input, conversationId, userId: user.id });
    const body: PostMessageResponse = {
      message: toMessage(result.message),
      job: toJobSummary(result.job),
    };
    return c.json(body, 201);
  });

  app.route("/", router);
  return router;
}
