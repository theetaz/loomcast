CREATE TYPE "public"."api_channel_access" AS ENUM('read', 'write', 'publish');--> statement-breakpoint
ALTER TYPE "public"."content_created_via" ADD VALUE 'api';--> statement-breakpoint
ALTER TYPE "public"."token_kind" ADD VALUE 'api';--> statement-breakpoint
ALTER TYPE "public"."version_created_via" ADD VALUE 'api';--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"token_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_keys_token_id_key_pk" PRIMARY KEY("token_id","key")
);
--> statement-breakpoint
CREATE TABLE "api_posts" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"token_id" uuid NOT NULL,
	"external_ref" text,
	"format" "post_format" NOT NULL,
	"caption" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_posts_media_ck" CHECK (jsonb_typeof("api_posts"."media") = 'array'),
	CONSTRAINT "api_posts_targets_ck" CHECK (jsonb_typeof("api_posts"."targets") = 'array')
);
--> statement-breakpoint
CREATE TABLE "api_token_channels" (
	"token_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"access" "api_channel_access" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_token_channels_token_id_channel_id_pk" PRIMARY KEY("token_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_posts" ADD CONSTRAINT "api_posts_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_posts" ADD CONSTRAINT "api_posts_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token_channels" ADD CONSTRAINT "api_token_channels_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token_channels" ADD CONSTRAINT "api_token_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_idempotency_keys_created_at_idx" ON "api_idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_posts_token_id_created_at_idx" ON "api_posts" USING btree ("token_id","created_at" DESC NULLS LAST,"item_id");--> statement-breakpoint
CREATE INDEX "api_token_channels_channel_id_idx" ON "api_token_channels" USING btree ("channel_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_project_id_ck" CHECK (("api_tokens"."kind"::text <> 'api' or "api_tokens"."project_id" is not null) and ("api_tokens"."kind"::text in ('job', 'api') or "api_tokens"."project_id" is null));