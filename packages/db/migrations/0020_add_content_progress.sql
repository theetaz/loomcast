CREATE TABLE "content_progress" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"path" text NOT NULL,
	"style" text,
	"steps" jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview_asset_id" uuid,
	"revision" bigint NOT NULL,
	"inferred" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_progress_revision_ck" CHECK ("content_progress"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "content_progress" ADD CONSTRAINT "content_progress_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_progress" ADD CONSTRAINT "content_progress_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_progress" ADD CONSTRAINT "content_progress_preview_asset_id_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_progress_workspace_id_updated_at_idx" ON "content_progress" USING btree ("workspace_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_progress_preview_asset_id_idx" ON "content_progress" USING btree ("preview_asset_id");