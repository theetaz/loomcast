-- Hand-edited: the indexes come before the foreign keys, because a composite foreign key needs a
-- unique index on the referenced columns, and content_items_current_version_fk is DEFERRABLE
-- INITIALLY DEFERRED (drizzle cannot express it) so an item and its first version can be inserted
-- in one transaction.
CREATE TYPE "public"."content_created_via" AS ENUM('ui', 'mcp', 'producer', 'system');--> statement-breakpoint
CREATE TYPE "public"."pipeline_state" AS ENUM('idea', 'script', 'storyboard', 'voice', 'render', 'review', 'approved', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."produce_target" AS ENUM('script', 'storyboard', 'voice', 'render', 'review');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approve', 'request_changes', 'reject');--> statement-breakpoint
CREATE TYPE "public"."version_created_via" AS ENUM('ui', 'mcp', 'job', 'system');--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid,
	"title" text NOT NULL,
	"pitch" text,
	"topic" text,
	"state" "pipeline_state" DEFAULT 'idea' NOT NULL,
	"current_version_id" uuid NOT NULL,
	"target_at" timestamp with time zone,
	"autopilot_target" "produce_target",
	"last_error" jsonb,
	"created_via" "content_created_via" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"stage" "pipeline_state" NOT NULL,
	"parent_version_id" uuid,
	"format_version_id" uuid,
	"script" jsonb,
	"storyboard" jsonb,
	"voice_asset_id" uuid,
	"render_asset_id" uuid,
	"poster_asset_id" uuid,
	"caption" text,
	"notes" text,
	"created_via" "version_created_via" NOT NULL,
	"created_by_user" uuid,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_versions_version_no_ck" CHECK ("content_versions"."version_no" >= 1)
);--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"comment" text,
	"enqueue_revision" boolean DEFAULT false NOT NULL,
	"user_id" uuid,
	"actor_kind" "actor_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_comment_ck" CHECK ("reviews"."decision"::text <> 'request_changes' or "reviews"."comment" is not null),
	CONSTRAINT "reviews_enqueue_revision_ck" CHECK (not "reviews"."enqueue_revision" or "reviews"."decision"::text = 'request_changes')
);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "content_item_id" uuid;--> statement-breakpoint
CREATE INDEX "content_items_project_id_state_updated_at_idx" ON "content_items" USING btree ("project_id","state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_items_series_id_target_at_idx" ON "content_items" USING btree ("series_id","target_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_item_id_version_no_uq" ON "content_versions" USING btree ("item_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_item_id_id_uq" ON "content_versions" USING btree ("item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_job_id_uq" ON "content_versions" USING btree ("job_id") WHERE "content_versions"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "reviews_item_id_created_at_idx" ON "reviews" USING btree ("item_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_content_item_id_idx" ON "conversations" USING btree ("content_item_id") WHERE "conversations"."content_item_id" is not null;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_current_version_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."content_versions"("item_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_format_version_id_format_versions_id_fk" FOREIGN KEY ("format_version_id") REFERENCES "public"."format_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_created_by_user_users_id_fk" FOREIGN KEY ("created_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_parent_version_fk" FOREIGN KEY ("item_id","parent_version_id") REFERENCES "public"."content_versions"("item_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_version_fk" FOREIGN KEY ("item_id","version_id") REFERENCES "public"."content_versions"("item_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;