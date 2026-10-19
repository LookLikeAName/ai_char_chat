CREATE TABLE "avatar_links" (
	"a_id" uuid NOT NULL,
	"b_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avatar_links_a_id_b_id_pk" PRIMARY KEY("a_id","b_id")
);
--> statement-breakpoint
ALTER TABLE "avatar_links" ADD CONSTRAINT "avatar_links_a_id_avatars_id_fk" FOREIGN KEY ("a_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avatar_links" ADD CONSTRAINT "avatar_links_b_id_avatars_id_fk" FOREIGN KEY ("b_id") REFERENCES "public"."avatars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "avatar_links_b_idx" ON "avatar_links" USING btree ("b_id");