import type { z } from "zod";
import type { GraphResponse } from "./client";
import { classifyMetaError, type GraphErrorFields, MetaGraphError } from "./errors";

/**
 * Validates a response body with `schema`. A body of another shape is a `permanent` failure: the
 * call worked, but the client cannot use what came back. The body is never quoted in the error.
 */
export function parseGraph<S extends z.ZodType>(
  schema: S,
  response: GraphResponse<unknown>,
  what: string,
): z.output<S> {
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) {
    const fields: GraphErrorFields = { status: response.status };
    throw new MetaGraphError(
      classifyMetaError(fields, `The platform answered ${what} in an unexpected shape.`),
      fields,
      response.usage,
    );
  }
  return parsed.data;
}
