CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" jsonb,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scheduled_tasks_kind_ck" CHECK (char_length("scheduled_tasks"."kind") between 1 and 100),
	CONSTRAINT "scheduled_tasks_attempts_ck" CHECK ("scheduled_tasks"."attempts" >= 0),
	CONSTRAINT "scheduled_tasks_max_attempts_ck" CHECK ("scheduled_tasks"."max_attempts" >= 1),
	CONSTRAINT "scheduled_tasks_lease_ck" CHECK ("scheduled_tasks"."status"::text <> 'running' or ("scheduled_tasks"."locked_by" is not null and "scheduled_tasks"."locked_until" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_dedupe_key_uq" ON "scheduled_tasks" USING btree ("dedupe_key") WHERE "scheduled_tasks"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "scheduled_tasks_pending_run_at_idx" ON "scheduled_tasks" USING btree ("run_at") WHERE "scheduled_tasks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "scheduled_tasks_running_locked_until_idx" ON "scheduled_tasks" USING btree ("locked_until") WHERE "scheduled_tasks"."status" = 'running';--> statement-breakpoint
CREATE INDEX "scheduled_tasks_status_run_at_idx" ON "scheduled_tasks" USING btree ("status","run_at" DESC NULLS LAST);