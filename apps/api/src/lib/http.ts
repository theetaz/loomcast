import { IdSchema } from "@loomcast/contracts";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../types";
import { badRequest, notFound, validationFailed } from "./errors";

export interface IssueDetail {
  path: string;
  message: string;
}

/** Zod issues as `ApiError.details`: the field path and a message, never the rejected value. */
export function issueDetails(error: z.ZodError): IssueDetail[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/** Parses the JSON body with `schema`; 400 `bad_request` or `validation_failed` otherwise. */
export async function readJson<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("The request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed(issueDetails(parsed.error));
  }
  return parsed.data;
}

/** A UUID path parameter. Anything else cannot name a row, so it is a 404. */
export function idParam(c: Context<AppEnv>, name = "id"): string {
  const parsed = IdSchema.safeParse(c.req.param(name));
  if (!parsed.success) {
    throw notFound();
  }
  return parsed.data;
}

/**
 * The client address. With `trustProxy`, the last `X-Forwarded-For` entry, which the proxy in
 * front of the API appended; otherwise the socket address.
 */
export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const last = forwarded
      ?.split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .at(-1);
    if (last !== undefined) {
      return last;
    }
  }
  return c.env?.incoming?.socket.remoteAddress ?? "unknown";
}

const MAX_USER_AGENT_LENGTH = 512;

export function userAgent(c: Context<AppEnv>): string | null {
  return c.req.header("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH) ?? null;
}
