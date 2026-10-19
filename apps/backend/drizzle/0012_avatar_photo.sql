ALTER TABLE "avatars" ADD COLUMN "photo" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "photo_reference_path" text;