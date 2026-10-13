-- Trigram matching for typo-tolerant title search. The dev stack's init script creates it too,
-- but every other database (tests, production) relies on this statement.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- array_to_string is only STABLE, so a generated column cannot call it directly. For text[] it
-- is immutable in practice; this wrapper declares that, and lowercases the tags for search.
CREATE OR REPLACE FUNCTION "public"."lc_tags_text"(tags text[]) RETURNS text
	LANGUAGE sql IMMUTABLE PARALLEL SAFE
	RETURN lower(coalesce(array_to_string(tags, ' '), ''));--> statement-breakpoint
CREATE TYPE "public"."kb_created_via" AS ENUM('ui', 'mcp', 'producer', 'hook');--> statement-breakpoint
CREATE TYPE "public"."kb_entry_kind" AS ENUM('brainstorm', 'reference', 'decision', 'note', 'session_summary');--> statement-breakpoint
CREATE TYPE "public"."reference_platform" AS ENUM('instagram', 'tiktok', 'youtube', 'threads', 'x', 'facebook', 'other');--> statement-breakpoint
CREATE TABLE "kb_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "kb_entry_kind" NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text,
	"conversation_id" uuid,
	"dedupe_key" text,
	"search_extra" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_by_token_id" uuid,
	"created_via" "kb_created_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, title), 'A') || setweight(to_tsvector('english'::regconfig, lc_tags_text(tags)), 'B') || setweight(to_tsvector('english'::regconfig, body_md), 'C') || setweight(to_tsvector('english'::regconfig, search_extra), 'D')) STORED,
	CONSTRAINT "kb_entries_title_length_ck" CHECK (char_length("kb_entries"."title") <= 300)
);
--> statement-breakpoint
CREATE TABLE "kb_references" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"platform" "reference_platform" NOT NULL,
	"author" text,
	"liked_reason" text,
	"transcript" text,
	"analysis" jsonb,
	"analysis_status" text DEFAULT 'none' NOT NULL,
	"analysis_job_id" uuid,
	"analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_references_analysis_status_ck" CHECK ("kb_references"."analysis_status" in ('none', 'queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD CONSTRAINT "kb_entries_created_by_token_id_api_tokens_id_fk" FOREIGN KEY ("created_by_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_references" ADD CONSTRAINT "kb_references_entry_id_kb_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."kb_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_references" ADD CONSTRAINT "kb_references_analysis_job_id_jobs_id_fk" FOREIGN KEY ("analysis_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_entries_search_idx" ON "kb_entries" USING gin ("search");--> statement-breakpoint
CREATE INDEX "kb_entries_title_trgm_idx" ON "kb_entries" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "kb_entries_tags_idx" ON "kb_entries" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "kb_entries_project_id_kind_updated_at_idx" ON "kb_entries" USING btree ("project_id","kind","updated_at" DESC NULLS LAST) WHERE "kb_entries"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_entries_project_id_dedupe_key_uq" ON "kb_entries" USING btree ("project_id","dedupe_key") WHERE "kb_entries"."dedupe_key" is not null and "kb_entries"."deleted_at" is null;