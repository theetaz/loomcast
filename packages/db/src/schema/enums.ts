import {
  ACTOR_KINDS,
  ASSET_KINDS,
  ASSET_STATUSES,
  CHANNEL_STATUSES,
  CONTENT_CREATED_VIA,
  JOB_STATUSES,
  JOB_TYPES,
  KB_CREATED_VIA,
  KB_ENTRY_KINDS,
  MESSAGE_ROLES,
  PASSWORD_TOKEN_PURPOSES,
  PIPELINE_STATES,
  PLATFORMS,
  POST_STATUSES,
  PRODUCE_TARGETS,
  PROJECT_STATUSES,
  REFERENCE_PLATFORMS,
  REVIEW_DECISIONS,
  SERIES_STATUSES,
  SKILL_KINDS,
  TOKEN_KINDS,
  TOKEN_SCOPES,
  USER_ROLES,
  VERSION_CREATED_VIA,
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
export const passwordTokenPurpose = pgEnum("password_token_purpose", PASSWORD_TOKEN_PURPOSES);
export const seriesStatus = pgEnum("series_status", SERIES_STATUSES);
export const pipelineState = pgEnum("pipeline_state", PIPELINE_STATES);
export const produceTarget = pgEnum("produce_target", PRODUCE_TARGETS);
export const contentCreatedVia = pgEnum("content_created_via", CONTENT_CREATED_VIA);
export const versionCreatedVia = pgEnum("version_created_via", VERSION_CREATED_VIA);
export const reviewDecision = pgEnum("review_decision", REVIEW_DECISIONS);
export const assetKind = pgEnum("asset_kind", ASSET_KINDS);
export const assetStatus = pgEnum("asset_status", ASSET_STATUSES);
export const skillKind = pgEnum("skill_kind", SKILL_KINDS);
export const platform = pgEnum("platform", PLATFORMS);
export const channelStatus = pgEnum("channel_status", CHANNEL_STATUSES);
export const postStatus = pgEnum("post_status", POST_STATUSES);
