import type { ActorKind, ContentCreatedVia, VersionCreatedVia } from "@loomcast/contracts";
import type { Context } from "hono";
import { clientIp } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";

/**
 * Who changes a format, series, item or review. The kind is what `PIPELINE_TRANSITIONS` checks:
 * - `user`: a signed-in user in the web app (`id` and `userId` are the user).
 * - `token`: an MCP token acting for its user (`id` is the token, `userId` its user). A job
 *   token of a producer session is a token too.
 * - `device`: a studio agent reporting a job result (`id` is the device, `userId` the user who
 *   started the job).
 * - `system`: the server itself, such as the scheduler (`id` and `userId` are null).
 */
export interface PipelineActor {
  kind: ActorKind;
  id: string | null;
  /** The account the change belongs to; stored as `created_by` and `created_by_user`. */
  userId: string | null;
  ip?: string | null;
}

/** The actor for the server's own moves (the scheduler, auto-approval). */
export const SYSTEM_ACTOR: PipelineActor = Object.freeze({
  kind: "system",
  id: null,
  userId: null,
});

/** The signed-in user of a cookie route as an actor. */
export function userActor(c: Context<AppEnv>, trustProxy: boolean): PipelineActor {
  const user = currentUser(c);
  return { kind: "user", id: user.id, userId: user.id, ip: clientIp(c, trustProxy) };
}

/** The audit columns of an actor. */
export function auditActor(actor: PipelineActor) {
  return { actorKind: actor.kind, actorId: actor.id, ip: actor.ip ?? null } as const;
}

/** How a version written by `actor` was created, unless the caller says otherwise. */
export function versionViaFor(actor: PipelineActor): VersionCreatedVia {
  switch (actor.kind) {
    case "user":
      return "ui";
    case "token":
      return "mcp";
    case "device":
      return "job";
    default:
      return "system";
  }
}

/**
 * How an item created by `actor` was created, unless the caller says otherwise. A producer
 * session's job token should pass `producer` explicitly.
 */
export function itemViaFor(actor: PipelineActor): ContentCreatedVia {
  switch (actor.kind) {
    case "user":
      return "ui";
    case "token":
      return "mcp";
    case "device":
      return "producer";
    default:
      return "system";
  }
}
