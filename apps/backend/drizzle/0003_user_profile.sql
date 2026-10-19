CREATE TABLE "user_profile" (
	"id" smallint PRIMARY KEY NOT NULL,
	"preferences" jsonb,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"summary_at" timestamp (3) with time zone,
	"inputs_updated_at" timestamp (3) with time zone
);
