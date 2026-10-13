-- Hand-edited: the indexes come before the foreign keys, because a composite foreign key needs a
-- unique index on the referenced columns, and skills_current_version_fk is DEFERRABLE INITIALLY
-- DEFERRED (drizzle cannot express it) so a skill and its first version can be inserted in one
-- transaction.
CREATE TYPE "public"."asset_kind" AS ENUM('voice', 'render', 'poster', 'frame', 'reference_media', 'other');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."skill_kind" AS ENUM('skill', 'recipe');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"item_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"status" "asset_status" DEFAULT 'pending' NOT NULL,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_job" uuid,
	"created_by_user" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "assets_bytes_ck" CHECK ("assets"."bytes" >= 0),
	CONSTRAINT "assets_sha256_ck" CHECK ("assets"."sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"files" jsonb NOT NULL,
	"checksum" char(64) NOT NULL,
	"changelog" text,
	"published_by_user" uuid,
	"published_by_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_version_ck" CHECK ("skill_versions"."version" >= 1),
	CONSTRAINT "skill_versions_checksum_ck" CHECK ("skill_versions"."checksum" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "skill_kind" NOT NULL,
	"current_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_ck" CHECK ("skills"."name" ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);--> statement-breakpoint
ALTER TABLE "kb_references" ADD COLUMN "media_asset_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_storage_key_uq" ON "assets" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_project_id_kind_sha256_uq" ON "assets" USING btree ("project_id","kind","sha256") WHERE "assets"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "assets_item_id_created_at_idx" ON "assets" USING btree ("item_id","created_at" DESC NULLS LAST) WHERE "assets"."item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_id_version_uq" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_id_checksum_uq" ON "skill_versions" USING btree ("skill_id","checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_id_id_uq" ON "skill_versions" USING btree ("skill_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_uq" ON "skills" USING btree ("name");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_job_jobs_id_fk" FOREIGN KEY ("created_by_job") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_user_users_id_fk" FOREIGN KEY ("created_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_published_by_user_users_id_fk" FOREIGN KEY ("published_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_published_by_token_api_tokens_id_fk" FOREIGN KEY ("published_by_token") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_current_version_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."skill_versions"("skill_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_voice_asset_id_assets_id_fk" FOREIGN KEY ("voice_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_render_asset_id_assets_id_fk" FOREIGN KEY ("render_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_poster_asset_id_assets_id_fk" FOREIGN KEY ("poster_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_references" ADD CONSTRAINT "kb_references_media_asset_id_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;