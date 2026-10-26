-- Projects are now called workspaces. Every object keeps its data and identity; only names change.
-- Audit rows written before this migration keep their `project` target type and actions.
ALTER TYPE "public"."project_status" RENAME TO "workspace_status";--> statement-breakpoint
ALTER TABLE "projects" RENAME TO "workspaces";--> statement-breakpoint
ALTER INDEX "projects_pkey" RENAME TO "workspaces_pkey";--> statement-breakpoint
ALTER INDEX "projects_slug_uq" RENAME TO "workspaces_slug_uq";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "projects_created_by_users_id_fk" TO "workspaces_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "api_tokens" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "api_tokens" RENAME CONSTRAINT "api_tokens_project_id_ck" TO "api_tokens_workspace_id_ck";--> statement-breakpoint
ALTER TABLE "api_tokens" RENAME CONSTRAINT "api_tokens_project_id_projects_id_fk" TO "api_tokens_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "assets" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "assets" RENAME CONSTRAINT "assets_project_id_projects_id_fk" TO "assets_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "assets_project_id_kind_sha256_uq" RENAME TO "assets_workspace_id_kind_sha256_uq";--> statement-breakpoint
ALTER INDEX "assets_project_id_item_id_kind_sha256_uq" RENAME TO "assets_workspace_id_item_id_kind_sha256_uq";--> statement-breakpoint
ALTER TABLE "competitor_scans" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "competitor_scans" RENAME CONSTRAINT "competitor_scans_project_id_projects_id_fk" TO "competitor_scans_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "competitors" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "competitors" RENAME CONSTRAINT "competitors_project_id_projects_id_fk" TO "competitors_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "competitors_project_id_idx" RENAME TO "competitors_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "competitors_project_id_platform_handle_uq" RENAME TO "competitors_workspace_id_platform_handle_uq";--> statement-breakpoint
ALTER TABLE "content_items" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "content_items" RENAME CONSTRAINT "content_items_project_id_projects_id_fk" TO "content_items_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "content_items_project_id_state_updated_at_idx" RENAME TO "content_items_workspace_id_state_updated_at_idx";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "conversations_project_id_projects_id_fk" TO "conversations_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "conversations_project_id_last_message_at_idx" RENAME TO "conversations_workspace_id_last_message_at_idx";--> statement-breakpoint
ALTER TABLE "formats" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "formats" RENAME CONSTRAINT "formats_project_id_projects_id_fk" TO "formats_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "formats_project_id_id_uq" RENAME TO "formats_workspace_id_id_uq";--> statement-breakpoint
ALTER INDEX "formats_project_id_slug_uq" RENAME TO "formats_workspace_id_slug_uq";--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_project_id_projects_id_fk" TO "jobs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "kb_entries" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "kb_entries" RENAME CONSTRAINT "kb_entries_project_id_projects_id_fk" TO "kb_entries_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "kb_entries_project_id_dedupe_key_uq" RENAME TO "kb_entries_workspace_id_dedupe_key_uq";--> statement-breakpoint
ALTER INDEX "kb_entries_project_id_kind_updated_at_idx" RENAME TO "kb_entries_workspace_id_kind_updated_at_idx";--> statement-breakpoint
ALTER TABLE "series" RENAME COLUMN "project_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "series" RENAME CONSTRAINT "series_project_id_projects_id_fk" TO "series_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "series_project_id_slug_uq" RENAME TO "series_workspace_id_slug_uq";
--> statement-breakpoint
UPDATE "jobs" SET "payload" = ("payload" - 'projectId') || jsonb_build_object('workspaceId', "payload" -> 'projectId') WHERE "payload" ? 'projectId';
