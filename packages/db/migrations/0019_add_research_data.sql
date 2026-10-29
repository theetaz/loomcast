CREATE TABLE "research_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"followers" bigint,
	"median_views" bigint,
	"source" text NOT NULL,
	"competitor_id" uuid,
	"last_synced_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_accounts_platform_ck" CHECK ("research_accounts"."platform" in ('instagram', 'tiktok', 'youtube', 'facebook', 'threads')),
	CONSTRAINT "research_accounts_source_ck" CHECK ("research_accounts"."source" in ('tracked', 'discovered')),
	CONSTRAINT "research_accounts_handle_ck" CHECK ("research_accounts"."handle" = lower("research_accounts"."handle") and char_length("research_accounts"."handle") between 1 and 100),
	CONSTRAINT "research_accounts_counts_ck" CHECK (coalesce("research_accounts"."followers", 0) >= 0 and coalesce("research_accounts"."median_views", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_video_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"video_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_video_snapshots_counts_ck" CHECK (coalesce("research_video_snapshots"."views", 0) >= 0 and coalesce("research_video_snapshots"."likes", 0) >= 0 and coalesce("research_video_snapshots"."comments", 0) >= 0 and coalesce("research_video_snapshots"."shares", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"caption" text,
	"posted_at" timestamp with time zone,
	"duration_s" real,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"outlier_score" double precision,
	"topic" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"hook" text,
	"format" text,
	"notes" text,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_videos_platform_ck" CHECK ("research_videos"."platform" in ('instagram', 'tiktok', 'youtube', 'facebook', 'threads')),
	CONSTRAINT "research_videos_source_ck" CHECK ("research_videos"."source" in ('business_discovery', 'manual', 'agent')),
	CONSTRAINT "research_videos_counts_ck" CHECK (coalesce("research_videos"."views", 0) >= 0 and coalesce("research_videos"."likes", 0) >= 0 and coalesce("research_videos"."comments", 0) >= 0 and coalesce("research_videos"."shares", 0) >= 0 and coalesce("research_videos"."outlier_score", 0) >= 0 and coalesce("research_videos"."duration_s", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "research_accounts" ADD CONSTRAINT "research_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_accounts" ADD CONSTRAINT "research_accounts_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_video_snapshots" ADD CONSTRAINT "research_video_snapshots_video_id_research_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."research_videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_videos" ADD CONSTRAINT "research_videos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_videos" ADD CONSTRAINT "research_videos_account_id_research_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."research_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_accounts_workspace_id_platform_handle_uq" ON "research_accounts" USING btree ("workspace_id","platform","handle");--> statement-breakpoint
CREATE INDEX "research_accounts_competitor_id_idx" ON "research_accounts" USING btree ("competitor_id");--> statement-breakpoint
CREATE INDEX "research_video_snapshots_video_id_captured_at_idx" ON "research_video_snapshots" USING btree ("video_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "research_videos_workspace_id_platform_external_id_uq" ON "research_videos" USING btree ("workspace_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "research_videos_account_id_posted_at_idx" ON "research_videos" USING btree ("account_id","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "research_videos_workspace_id_topic_idx" ON "research_videos" USING btree ("workspace_id","topic");