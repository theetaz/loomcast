CREATE TABLE "post_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"saves" bigint,
	"reach" bigint,
	"avg_watch_ms" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_metrics_counts_ck" CHECK (coalesce("post_metrics"."views", 0) >= 0 and coalesce("post_metrics"."likes", 0) >= 0 and coalesce("post_metrics"."comments", 0) >= 0 and coalesce("post_metrics"."shares", 0) >= 0 and coalesce("post_metrics"."saves", 0) >= 0 and coalesce("post_metrics"."reach", 0) >= 0 and coalesce("post_metrics"."avg_watch_ms", 0) >= 0),
	CONSTRAINT "post_metrics_raw_ck" CHECK (jsonb_typeof("post_metrics"."raw") = 'object')
);
--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_scheduled_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."scheduled_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_metrics_post_id_captured_at_idx" ON "post_metrics" USING btree ("post_id","captured_at" DESC NULLS FIRST);