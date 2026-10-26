-- Workspaces gain an accent colour, an optional icon and a time zone, and every channel moves into
-- one workspace. A channel goes to the workspace whose items it published most, else the workspace
-- of a series or API client that uses it; an Instagram account follows its Page. A channel still
-- without a workspace gets a new one named after it. Series links and API client grants that would
-- cross workspaces afterwards are removed. Posts keep their channel: a post whose item belongs to
-- another workspace than its channel stays as it is.
CREATE TYPE "public"."workspace_color" AS ENUM('thread', 'ember', 'moss', 'ocean', 'plum', 'amber', 'rose', 'slate');--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "color" "workspace_color" DEFAULT 'thread' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "icon" "bytea";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "icon_mime" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "icon_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_icon_ck" CHECK (num_nulls("workspaces"."icon", "workspaces"."icon_mime", "workspaces"."icon_updated_at") in (0, 3));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_icon_size_ck" CHECK (octet_length("workspaces"."icon") between 1 and 524288);--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_icon_mime_ck" CHECK ("workspaces"."icon_mime" in ('image/png', 'image/jpeg', 'image/webp'));--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "channels" SET "workspace_id" = (
  SELECT "content_items"."workspace_id"
  FROM "scheduled_posts"
  JOIN "content_items" ON "content_items"."id" = "scheduled_posts"."item_id"
  WHERE "scheduled_posts"."channel_id" = "channels"."id"
  GROUP BY "content_items"."workspace_id"
  ORDER BY count(*) DESC, "content_items"."workspace_id"
  LIMIT 1
);--> statement-breakpoint
UPDATE "channels" SET "workspace_id" = (
  SELECT "series"."workspace_id"
  FROM "series_channels"
  JOIN "series" ON "series"."id" = "series_channels"."series_id"
  WHERE "series_channels"."channel_id" = "channels"."id"
  GROUP BY "series"."workspace_id"
  ORDER BY count(*) DESC, "series"."workspace_id"
  LIMIT 1
) WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "channels" SET "workspace_id" = (
  SELECT "api_tokens"."workspace_id"
  FROM "api_token_channels"
  JOIN "api_tokens" ON "api_tokens"."id" = "api_token_channels"."token_id"
  WHERE "api_token_channels"."channel_id" = "channels"."id" AND "api_tokens"."workspace_id" IS NOT NULL
  GROUP BY "api_tokens"."workspace_id"
  ORDER BY count(*) DESC, "api_tokens"."workspace_id"
  LIMIT 1
) WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "channels" AS "page" SET "workspace_id" = (
  SELECT "child"."workspace_id"
  FROM "channels" AS "child"
  WHERE "child"."parent_channel_id" = "page"."id" AND "child"."workspace_id" IS NOT NULL
  GROUP BY "child"."workspace_id"
  ORDER BY count(*) DESC, "child"."workspace_id"
  LIMIT 1
) WHERE "page"."workspace_id" IS NULL;--> statement-breakpoint
DO $$
DECLARE
  orphan record;
  base text;
  candidate text;
  n integer;
  owner_id uuid;
  created uuid;
BEGIN
  FOR orphan IN
    SELECT "id", "display_name", "created_by" FROM "channels"
    WHERE "workspace_id" IS NULL AND "parent_channel_id" IS NULL
    ORDER BY "created_at", "id"
  LOOP
    base := trim(both '-' from left(regexp_replace(lower("orphan"."display_name"), '[^a-z0-9]+', '-', 'g'), 56));
    IF base = '' OR base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      base := 'workspace';
    END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "workspaces" WHERE "slug" = candidate) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    owner_id := coalesce(
      "orphan"."created_by",
      (SELECT "id" FROM "users" WHERE "role" = 'owner' ORDER BY "created_at" LIMIT 1),
      (SELECT "id" FROM "users" ORDER BY "created_at" LIMIT 1)
    );
    INSERT INTO "workspaces" ("slug", "name", "created_by")
    VALUES (candidate, left("orphan"."display_name", 120), owner_id)
    RETURNING "id" INTO created;
    UPDATE "channels" SET "workspace_id" = created WHERE "id" = "orphan"."id";
  END LOOP;
END $$;--> statement-breakpoint
UPDATE "channels" AS "child" SET "workspace_id" = "page"."workspace_id"
FROM "channels" AS "page"
WHERE "child"."parent_channel_id" = "page"."id" AND "page"."workspace_id" IS NOT NULL
  AND "child"."workspace_id" IS DISTINCT FROM "page"."workspace_id";--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_workspace_id_id_uq" ON "channels" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_workspace_id_id_uq" ON "series" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_workspace_id_id_uq" ON "api_tokens" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "series_channels" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "series_channels" SET "workspace_id" = "series"."workspace_id"
FROM "series" WHERE "series"."id" = "series_channels"."series_id";--> statement-breakpoint
DELETE FROM "series_channels" USING "channels"
WHERE "channels"."id" = "series_channels"."channel_id" AND "channels"."workspace_id" <> "series_channels"."workspace_id";--> statement-breakpoint
ALTER TABLE "series_channels" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "series_channels" DROP CONSTRAINT "series_channels_series_id_series_id_fk";--> statement-breakpoint
ALTER TABLE "series_channels" DROP CONSTRAINT "series_channels_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "series_channels" ADD CONSTRAINT "series_channels_series_fk" FOREIGN KEY ("workspace_id","series_id") REFERENCES "public"."series"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_channels" ADD CONSTRAINT "series_channels_channel_fk" FOREIGN KEY ("workspace_id","channel_id") REFERENCES "public"."channels"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token_channels" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "api_token_channels" SET "workspace_id" = "api_tokens"."workspace_id"
FROM "api_tokens" WHERE "api_tokens"."id" = "api_token_channels"."token_id";--> statement-breakpoint
DELETE FROM "api_token_channels" USING "channels"
WHERE "channels"."id" = "api_token_channels"."channel_id"
  AND "channels"."workspace_id" IS DISTINCT FROM "api_token_channels"."workspace_id";--> statement-breakpoint
DELETE FROM "api_token_channels" WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "api_token_channels" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_token_channels" DROP CONSTRAINT "api_token_channels_token_id_api_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "api_token_channels" DROP CONSTRAINT "api_token_channels_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "api_token_channels" ADD CONSTRAINT "api_token_channels_token_fk" FOREIGN KEY ("workspace_id","token_id") REFERENCES "public"."api_tokens"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token_channels" ADD CONSTRAINT "api_token_channels_channel_fk" FOREIGN KEY ("workspace_id","channel_id") REFERENCES "public"."channels"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
