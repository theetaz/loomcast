-- Hand-edited: the unique indexes come before the foreign keys, because a composite foreign key
-- needs a unique index on the referenced columns, and formats_current_version_fk is DEFERRABLE
-- INITIALLY DEFERRED (drizzle cannot express it) so a format and its first version can be
-- inserted in one transaction.
CREATE TYPE "public"."series_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "format_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "format_versions_version_no_ck" CHECK ("format_versions"."version_no" >= 1)
);--> statement-breakpoint
CREATE TABLE "formats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"current_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"format_id" uuid NOT NULL,
	"status" "series_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX "format_versions_format_id_version_no_uq" ON "format_versions" USING btree ("format_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "format_versions_format_id_id_uq" ON "format_versions" USING btree ("format_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "formats_project_id_slug_uq" ON "formats" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "formats_project_id_id_uq" ON "formats" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_project_id_slug_uq" ON "series" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "series_format_id_idx" ON "series" USING btree ("format_id");--> statement-breakpoint
ALTER TABLE "format_versions" ADD CONSTRAINT "format_versions_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "format_versions" ADD CONSTRAINT "format_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formats" ADD CONSTRAINT "formats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formats" ADD CONSTRAINT "formats_current_version_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."format_versions"("format_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_format_fk" FOREIGN KEY ("project_id","format_id") REFERENCES "public"."formats"("project_id","id") ON DELETE no action ON UPDATE no action;