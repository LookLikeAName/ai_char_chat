ALTER TABLE "avatars" ADD COLUMN "daily_token_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_profiles" ADD COLUMN "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_log_avatar_created_idx" ON "usage_log" USING btree ("avatar_id","created_at");