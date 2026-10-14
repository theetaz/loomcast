ALTER TYPE "public"."job_type" ADD VALUE 'kb.competitor_report' BEFORE 'content.write_script';--> statement-breakpoint
CREATE TABLE "competitor_scan_videos" (
	"scan_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"analysis_job_id" uuid,
	"external_id" text,
	"url" text NOT NULL,
	"caption" text,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competitor_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"top_n" integer NOT NULL,
	"channel_id" uuid,
	"report_job_id" uuid,
	"report_entry_id" uuid,
	"error" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "competitor_scans_status_ck" CHECK ("competitor_scans"."status" in ('analyzing', 'reporting', 'done', 'partial', 'failed', 'cancelled')),
	CONSTRAINT "competitor_scans_source_ck" CHECK ("competitor_scans"."source" in ('official_api', 'links')),
	CONSTRAINT "competitor_scans_top_n_ck" CHECK ("competitor_scans"."top_n" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"profile_url" text NOT NULL,
	"notes" text,
	"display_name" text,
	"followers_count" bigint,
	"media_count" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "competitors_platform_ck" CHECK ("competitors"."platform" in ('instagram', 'facebook', 'threads'))
);
--> statement-breakpoint
ALTER TABLE "kb_references" ADD COLUMN "media_facts" jsonb;--> statement-breakpoint
ALTER TABLE "competitor_scan_videos" ADD CONSTRAINT "competitor_scan_videos_scan_id_competitor_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."competitor_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scan_videos" ADD CONSTRAINT "competitor_scan_videos_entry_id_kb_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."kb_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scan_videos" ADD CONSTRAINT "competitor_scan_videos_analysis_job_id_jobs_id_fk" FOREIGN KEY ("analysis_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scans" ADD CONSTRAINT "competitor_scans_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scans" ADD CONSTRAINT "competitor_scans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scans" ADD CONSTRAINT "competitor_scans_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scans" ADD CONSTRAINT "competitor_scans_report_job_id_jobs_id_fk" FOREIGN KEY ("report_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scans" ADD CONSTRAINT "competitor_scans_report_entry_id_kb_entries_id_fk" FOREIGN KEY ("report_entry_id") REFERENCES "public"."kb_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_scans" ADD CONSTRAINT "competitor_scans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_scan_videos_scan_id_entry_id_uq" ON "competitor_scan_videos" USING btree ("scan_id","entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_scan_videos_scan_id_rank_uq" ON "competitor_scan_videos" USING btree ("scan_id","rank");--> statement-breakpoint
CREATE INDEX "competitor_scan_videos_entry_id_idx" ON "competitor_scan_videos" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "competitor_scan_videos_analysis_job_id_idx" ON "competitor_scan_videos" USING btree ("analysis_job_id");--> statement-breakpoint
CREATE INDEX "competitor_scans_competitor_id_created_at_idx" ON "competitor_scans" USING btree ("competitor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "competitor_scans_report_job_id_idx" ON "competitor_scans" USING btree ("report_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_scans_one_active_uq" ON "competitor_scans" USING btree ("competitor_id") WHERE "competitor_scans"."status" in ('analyzing', 'reporting');--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_project_id_platform_handle_uq" ON "competitors" USING btree ("project_id","platform",lower("handle")) WHERE "competitors"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "competitors_project_id_idx" ON "competitors" USING btree ("project_id") WHERE "competitors"."deleted_at" is null;