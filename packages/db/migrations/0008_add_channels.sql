CREATE TYPE "public"."channel_status" AS ENUM('disconnected', 'active', 'needs_reauth', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('facebook', 'instagram', 'threads', 'x');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "platform" NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"username" text,
	"parent_channel_id" uuid,
	"status" "channel_status" DEFAULT 'disconnected' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"secret_ciphertext" "bytea",
	"secret_nonce" "bytea",
	"key_version" integer,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_expires_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "channels_display_name_ck" CHECK (char_length("channels"."display_name") between 1 and 200),
	CONSTRAINT "channels_secret_ck" CHECK (num_nulls("channels"."secret_ciphertext", "channels"."secret_nonce", "channels"."key_version") in (0, 3)),
	CONSTRAINT "channels_secret_nonce_ck" CHECK (octet_length("channels"."secret_nonce") = 12),
	CONSTRAINT "channels_secret_ciphertext_ck" CHECK (octet_length("channels"."secret_ciphertext") > 16),
	CONSTRAINT "channels_key_version_ck" CHECK ("channels"."key_version" >= 1),
	CONSTRAINT "channels_status_secret_ck" CHECK (case "channels"."status"::text when 'active' then "channels"."secret_ciphertext" is not null when 'disconnected' then "channels"."secret_ciphertext" is null else true end),
	CONSTRAINT "channels_parent_ck" CHECK ("channels"."parent_channel_id" <> "channels"."id")
);
--> statement-breakpoint
CREATE TABLE "series_channels" (
	"series_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_channels_pk" PRIMARY KEY("series_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_parent_channel_id_channels_id_fk" FOREIGN KEY ("parent_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_channels" ADD CONSTRAINT "series_channels_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_channels" ADD CONSTRAINT "series_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_platform_external_id_uq" ON "channels" USING btree ("platform","external_id") WHERE "channels"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "channels_parent_channel_id_idx" ON "channels" USING btree ("parent_channel_id") WHERE "channels"."parent_channel_id" is not null;--> statement-breakpoint
CREATE INDEX "series_channels_channel_id_idx" ON "series_channels" USING btree ("channel_id");