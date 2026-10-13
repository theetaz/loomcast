import {
  ACTOR_KINDS,
  JOB_STATUSES,
  JOB_TYPES,
  KB_CREATED_VIA,
  KB_ENTRY_KINDS,
  MESSAGE_ROLES,
  PROJECT_STATUSES,
  REFERENCE_PLATFORMS,
  TOKEN_KINDS,
  TOKEN_SCOPES,
  USER_ROLES,
} from "@loomcast/contracts";
import { pgEnum } from "drizzle-orm/pg-core";

// pg enums built from the value arrays in `@loomcast/contracts`, which stay the single source of
// truth. Adding a value means changing the contracts array and generating a migration
// (`ALTER TYPE ... ADD VALUE`). Values are never removed or renamed in place.

export const userRole = pgEnum("user_role", USER_ROLES);
export const tokenKind = pgEnum("token_kind", TOKEN_KINDS);
export const tokenScope = pgEnum("token_scope", TOKEN_SCOPES);
export const projectStatus = pgEnum("project_status", PROJECT_STATUSES);
export const jobType = pgEnum("job_type", JOB_TYPES);
export const jobStatus = pgEnum("job_status", JOB_STATUSES);
export const messageRole = pgEnum("message_role", MESSAGE_ROLES);
export const actorKind = pgEnum("actor_kind", ACTOR_KINDS);
export const kbEntryKind = pgEnum("kb_entry_kind", KB_ENTRY_KINDS);
export const kbCreatedVia = pgEnum("kb_created_via", KB_CREATED_VIA);
export const referencePlatform = pgEnum("reference_platform", REFERENCE_PLATFORMS);
