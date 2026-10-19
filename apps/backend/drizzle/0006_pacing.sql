CREATE TABLE "life_logs" (
	"avatar_id" uuid NOT NULL,
	"date" text NOT NULL,
	"events" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "life_logs_avatar_id_date_pk" PRIMARY KEY("avatar_id","date")
);
--> statement-breakpoint
ALTER TABLE "avatar_state" ADD COLUMN "proactive_date" text;--> statement-breakpoint
ALTER TABLE "avatar_state" ADD COLUMN "proactive_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "reply_due_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "reply_reason" text;--> statement-breakpoint
ALTER TABLE "life_logs" ADD CONSTRAINT "life_logs_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;