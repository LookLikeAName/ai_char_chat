CREATE TABLE "event_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"category" text NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"avatar_id" uuid,
	"conversation_id" uuid,
	"trace_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"avatar_id" uuid,
	"conversation_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request" jsonb,
	"response" text,
	"parsed" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "event_log_at_idx" ON "event_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "event_log_avatar_idx" ON "event_log" USING btree ("avatar_id","at");--> statement-breakpoint
CREATE INDEX "llm_traces_created_idx" ON "llm_traces" USING btree ("created_at");