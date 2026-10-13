CREATE TYPE "public"."oauth_provider" AS ENUM('meta', 'threads', 'x');--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_ciphertext" "bytea",
	"secret_nonce" "bytea",
	"key_version" integer,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_connections_secret_ck" CHECK (num_nulls("oauth_connections"."secret_ciphertext", "oauth_connections"."secret_nonce", "oauth_connections"."key_version") in (0, 3)),
	CONSTRAINT "oauth_connections_secret_nonce_ck" CHECK (octet_length("oauth_connections"."secret_nonce") = 12),
	CONSTRAINT "oauth_connections_secret_ciphertext_ck" CHECK (octet_length("oauth_connections"."secret_ciphertext") > 16),
	CONSTRAINT "oauth_connections_key_version_ck" CHECK ("oauth_connections"."key_version" >= 1),
	CONSTRAINT "oauth_connections_consumed_ck" CHECK (("oauth_connections"."consumed_at" is null) = ("oauth_connections"."secret_ciphertext" is not null)),
	CONSTRAINT "oauth_connections_candidates_ck" CHECK (case when jsonb_typeof("oauth_connections"."candidates") = 'array' then jsonb_array_length("oauth_connections"."candidates") <= 100 else false end),
	CONSTRAINT "oauth_connections_expires_at_ck" CHECK ("oauth_connections"."expires_at" > "oauth_connections"."created_at")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"user_id" uuid NOT NULL,
	"pkce_ciphertext" "bytea",
	"pkce_nonce" "bytea",
	"key_version" integer,
	"redirect_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_state_hash_ck" CHECK ("oauth_states"."state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_states_pkce_ck" CHECK (num_nulls("oauth_states"."pkce_ciphertext", "oauth_states"."pkce_nonce", "oauth_states"."key_version") in (0, 3)),
	CONSTRAINT "oauth_states_pkce_nonce_ck" CHECK (octet_length("oauth_states"."pkce_nonce") = 12),
	CONSTRAINT "oauth_states_pkce_ciphertext_ck" CHECK (octet_length("oauth_states"."pkce_ciphertext") > 16),
	CONSTRAINT "oauth_states_key_version_ck" CHECK ("oauth_states"."key_version" >= 1),
	CONSTRAINT "oauth_states_pkce_used_ck" CHECK ("oauth_states"."used_at" is null or "oauth_states"."pkce_ciphertext" is null),
	CONSTRAINT "oauth_states_redirect_to_ck" CHECK (char_length("oauth_states"."redirect_to") <= 512 and "oauth_states"."redirect_to" like '/%'),
	CONSTRAINT "oauth_states_expires_at_ck" CHECK ("oauth_states"."expires_at" > "oauth_states"."created_at")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_error" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "rate_limit" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_connections_user_id_idx" ON "oauth_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_connections_expires_at_idx" ON "oauth_connections" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_hash_uq" ON "oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_states_user_id_idx" ON "oauth_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_last_error_ck" CHECK (jsonb_typeof("channels"."last_error") = 'object');--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_rate_limit_ck" CHECK (jsonb_typeof("channels"."rate_limit") = 'object');