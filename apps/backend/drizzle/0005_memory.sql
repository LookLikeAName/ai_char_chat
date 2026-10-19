CREATE TABLE "avatar_state" (
	"avatar_id" uuid PRIMARY KEY NOT NULL,
	"mood" jsonb NOT NULL,
	"mood_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reflected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"avatar_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"importance" integer DEFAULT 5 NOT NULL,
	"about" text DEFAULT 'user' NOT NULL,
	"source_conversation_id" uuid,
	"visibility" text DEFAULT 'private' NOT NULL,
	"embedding" vector(768),
	"embedding_model" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"avatar_id" uuid NOT NULL,
	"target" text NOT NULL,
	"stage" text NOT NULL,
	"affinity" integer NOT NULL,
	"trust" integer NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "memory_up_to" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "avatar_state" ADD CONSTRAINT "avatar_state_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_avatar_idx" ON "memories" USING btree ("avatar_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_avatar_target_idx" ON "relationships" USING btree ("avatar_id","target");