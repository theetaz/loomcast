CREATE TYPE "public"."post_format" AS ENUM('reel', 'video', 'image', 'carousel', 'story', 'text');--> statement-breakpoint
ALTER TYPE "public"."asset_kind" ADD VALUE 'media';--> statement-breakpoint
ALTER TABLE "content_versions" ADD COLUMN "format" "post_format" DEFAULT 'reel' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_versions" ADD COLUMN "media" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;