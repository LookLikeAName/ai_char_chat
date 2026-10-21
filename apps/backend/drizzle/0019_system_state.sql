CREATE TABLE "system_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"worker_seen_at" timestamp with time zone,
	"catch_up" jsonb
);
