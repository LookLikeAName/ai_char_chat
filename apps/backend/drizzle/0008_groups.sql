ALTER TABLE "conversations" ADD COLUMN "turn_due_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "user_typing_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handled_up_to" timestamp (3) with time zone;