CREATE TABLE "auth_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"password_hash" text,
	"session_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
