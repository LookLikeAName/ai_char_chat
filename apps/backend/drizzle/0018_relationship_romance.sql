ALTER TABLE "relationships" ADD COLUMN "romance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 已經在曖昧或交往的，給一個符合現況的心動
UPDATE "relationships" SET "romance" = CASE "stage" WHEN 'crush' THEN 50 WHEN 'lover' THEN 70 ELSE 0 END WHERE "target" = 'user';
