CREATE TABLE "usage_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"avatar_id" uuid,
	"profile_id" uuid,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
DROP INDEX "messages_conversation_created_idx";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "seen_up_to" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "handled_up_to" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "user_read_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_profile_id_llm_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."llm_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_log_created_idx" ON "usage_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at","seq");