// 聊天圖片的檔案整理：上傳了沒送出、或對話已經刪掉的圖片，放一天後刪除。
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { messages } from '../db/schema.ts';

/** 玩家上傳的圖片、avatar 傳的照片 */
export const CHAT_MEDIA_DIRS = ['uploads', 'photos'] as const;
const KEEP_MS = 24 * 60 * 60 * 1000;

export async function pruneChatMedia(db: Db, mediaDir: string, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const dir of CHAT_MEDIA_DIRS) {
    const names = await readdir(path.join(mediaDir, dir)).catch(() => [] as string[]);
    const old: string[] = [];
    for (const n of names) {
      const s = await stat(path.join(mediaDir, dir, n)).catch(() => null);
      if (s?.isFile() && now - s.mtimeMs > KEEP_MS) old.push(`${dir}/${n}`);
    }
    for (let i = 0; i < old.length; i += 500) {
      const batch = old.slice(i, i + 500);
      const used = await db
        .select({ path: sql<string>`${messages.meta}->'image'->>'path'` })
        .from(messages)
        .where(inArray(sql`${messages.meta}->'image'->>'path'`, batch));
      const keep = new Set(used.map((u) => u.path));
      for (const p of batch) {
        if (keep.has(p)) continue;
        await rm(path.join(mediaDir, p), { force: true });
        removed++;
      }
    }
  }
  return removed;
}
