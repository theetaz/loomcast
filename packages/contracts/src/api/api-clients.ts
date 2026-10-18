import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { ApiChannelAccessSchema, PlatformSchema } from "../enums";
import { ApiKeySecretSchema, TOKEN_NAME_MAX_LENGTH } from "./tokens";

// API clients: the owner's other backends, which call the machine API (`/api/v1`) with an API key
// (`lc_api_…`). The owner creates a client for one project and grants it channels, each with an
// access level; the client reaches nothing else. Only the owner manages clients.

/** Most channels one client may be granted. */
export const API_CLIENT_MAX_GRANTS = 100;

/** One channel granted to a client, as the owner sets it. */
export const ApiChannelGrantSchema = z.object({
  channelId: IdSchema,
  access: ApiChannelAccessSchema,
});
export type ApiChannelGrant = z.infer<typeof ApiChannelGrantSchema>;

/** A client's grants: at least one channel, each at most once. */
export const ApiChannelGrantsSchema = z
  .array(ApiChannelGrantSchema)
  .min(1)
  .max(API_CLIENT_MAX_GRANTS)
  .refine((grants) => new Set(grants.map((grant) => grant.channelId)).size === grants.length, {
    message: "A channel may be granted only once",
  });

/** A grant as Settings lists it, with the channel it names. */
export const ApiClientGrantSchema = ApiChannelGrantSchema.extend({
  platform: PlatformSchema,
  channelName: z.string(),
});
export type ApiClientGrant = z.infer<typeof ApiClientGrantSchema>;

/** An API client as Settings lists it. The key is never included. */
export const ApiClientSchema = z.object({
  id: IdSchema,
  name: z.string(),
  /** First characters of the key, shown so the owner can tell clients apart. */
  prefix: z.string().min(1).max(32),
  projectId: IdSchema,
  projectName: z.string(),
  grants: z.array(ApiClientGrantSchema),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
});
export type ApiClient = z.infer<typeof ApiClientSchema>;

const ApiClientNameSchema = z.string().trim().min(1).max(TOKEN_NAME_MAX_LENGTH);

/** Creates a client in a project with its channel grants. Owner only. */
export const CreateApiClientRequestSchema = z
  .object({
    name: ApiClientNameSchema,
    projectId: IdSchema,
    grants: ApiChannelGrantsSchema,
    expiresAt: TimestampSchema.optional(),
  })
  .strict();
export type CreateApiClientRequest = z.infer<typeof CreateApiClientRequestSchema>;

/** `secret` is the API key, returned only in this response and never stored or shown again. */
export const CreateApiClientResponseSchema = z.object({
  client: ApiClientSchema,
  secret: ApiKeySecretSchema,
});
export type CreateApiClientResponse = z.infer<typeof CreateApiClientResponseSchema>;

/** Renames a client or replaces its grants. Changes apply to the client's next request. */
export const UpdateApiClientRequestSchema = z
  .object({
    name: ApiClientNameSchema.optional(),
    grants: ApiChannelGrantsSchema.optional(),
  })
  .strict()
  .refine((update) => update.name !== undefined || update.grants !== undefined, {
    message: "Change the name or the grants",
  });
export type UpdateApiClientRequest = z.infer<typeof UpdateApiClientRequestSchema>;
