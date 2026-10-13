CREATE TYPE "public"."post_status" AS ENUM('planned', 'queued', 'publishing', 'published', 'failed', 'cancelled', 'missed');--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"adapter" "platform" NOT NULL,
	"dry_run" boolean NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_attempts_attempt_ck" CHECK ("publish_attempts"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "scheduled_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid,
	"channel_id" uuid NOT NULL,
	"series_id" uuid,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" "post_status" DEFAULT 'planned' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"external_id" text,
	"external_container_id" text,
	"permalink" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_posts_attempts_ck" CHECK ("scheduled_posts"."attempts" >= 0),
	CONSTRAINT "scheduled_posts_version_ck" CHECK ("scheduled_posts"."status"::text not in ('queued', 'publishing', 'published') or "scheduled_posts"."version_id" is not null),
	CONSTRAINT "scheduled_posts_published_at_ck" CHECK ("scheduled_posts"."status"::text <> 'published' or "scheduled_posts"."published_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_post_id_scheduled_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."scheduled_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_version_fk" FOREIGN KEY ("item_id","version_id") REFERENCES "public"."content_versions"("item_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publish_attempts_post_id_attempt_uq" ON "publish_attempts" USING btree ("post_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_posts_item_id_channel_id_uq" ON "scheduled_posts" USING btree ("item_id","channel_id") WHERE "scheduled_posts"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "scheduled_posts_open_scheduled_at_idx" ON "scheduled_posts" USING btree ("scheduled_at") WHERE "scheduled_posts"."status" in ('planned', 'queued');--> statement-breakpoint
CREATE INDEX "scheduled_posts_channel_id_scheduled_at_idx" ON "scheduled_posts" USING btree ("channel_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "scheduled_posts_series_id_scheduled_at_idx" ON "scheduled_posts" USING btree ("series_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "scheduled_posts_item_id_idx" ON "scheduled_posts" USING btree ("item_id");