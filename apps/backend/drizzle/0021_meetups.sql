CREATE TABLE "meetups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"avatar_id" uuid NOT NULL,
	"place" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"ended_by" text
);
--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetups_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetups" ADD CONSTRAINT "meetups_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetups_conversation_idx" ON "meetups" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meetups_active_idx" ON "meetups" USING btree ("conversation_id") WHERE ended_at is null;