// avatar 傳照片：照它寫的描述，用「設定 → 一般 → 頭像生成」的圖片模型生成。
// 有頭像而且是 Gemini 的圖片模型時，把頭像當參考圖，照片裡的人才會長得像它。
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gte, sql } from 'drizzle-orm';
import { IMAGE_STYLES, type AppSettings } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { avatars, messages, usageLog, type MessageImage } from '../db/schema.ts';
import { generateImage } from '../images/generate.ts';
import { inspectImage } from '../images/inspect.ts';
import type { FetchFn } from '../llm/index.ts';
import { getProfile, resolveRow } from './llmProfiles.ts';
import { localDayStart, quotaStatus } from './usage.ts';

export const PHOTO_DIR = 'photos';

/** 今天還能傳幾張；不能傳照片（沒設定圖片模型、關掉了、超過用量上限）時回傳 null */
export async function photosRemaining(
  db: Db,
  settings: AppSettings,
  avatarId: string,
  opts: { mediaDir?: string; now?: Date } = {},
): Promise<number | null> {
  if (!opts.mediaDir || !settings.imageGen || !settings.photos.enabled) return null;
  const now = opts.now ?? new Date();
  if ((await quotaStatus(db, avatarId, now)).over) return null;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.senderAvatarId, avatarId),
        sql`${messages.meta} ? 'image'`,
        gte(messages.createdAt, localDayStart(now, settings.timezone)),
      ),
    );
  return Math.max(0, settings.photos.dailyLimit - Number(row?.n ?? 0));
}

export function photoPrompt(
  avatar: Pick<typeof avatars.$inferSelect, 'name' | 'persona'>,
  description: string,
  opts: { style: AppSettings['photos']['style']; adult: boolean; hasReference: boolean },
): string {
  const b = avatar.persona.basic ?? {};
  const self = [
    b.age ? `${b.age} 歲` : '',
    b.gender ?? '',
    b.appearance ? `外貌：${b.appearance}` : '',
    b.style ? `穿著風格：${b.style}` : '',
  ]
    .filter(Boolean)
    .join('，');
  return [
    '一張用手機拍的照片，像是傳訊息給朋友看的生活照：自然、隨手拍的感覺，沒有文字、浮水印或邊框。',
    `畫面：${description}`,
    self || opts.hasReference
      ? `如果畫面裡有拍照的人自己（例如自拍）：${self}${opts.hasReference ? `${self ? '；' : ''}長相要和參考圖裡的人是同一個人` : ''}。`
      : '',
    `風格：${IMAGE_STYLES[opts.style]}。`,
    opts.adult ? '' : '非裸露、適合一般場合。',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function takePhoto(
  deps: { db: Db; box: SecretBox; mediaDir: string; fetchFn?: FetchFn },
  settings: AppSettings,
  avatar: typeof avatars.$inferSelect,
  description: string,
): Promise<MessageImage> {
  const gen = settings.imageGen!;
  const profile = await getProfile(deps.db, gen.profileId);
  const llm = { ...resolveRow(profile, deps.box), model: gen.model };
  const usesReference = llm.provider === 'google' && !/^(models\/)?imagen/.test(llm.model);
  const refData = usesReference && avatar.imagePath ? await readFile(path.join(deps.mediaDir, avatar.imagePath)).catch(() => null) : null;
  const refInfo = refData && inspectImage(refData);
  const reference = refData && refInfo ? { mime: refInfo.mime, data: refData } : null;
  const prompt = photoPrompt(avatar, description, { style: settings.photos.style, adult: settings.adultContent, hasReference: !!reference });

  const started = Date.now();
  const log = (ok: boolean, error?: string) =>
    deps.db
      .insert(usageLog)
      .values({ purpose: 'photo.generate', avatarId: avatar.id, profileId: profile.id, model: gen.model, latencyMs: Date.now() - started, ok, error: error?.slice(0, 500) ?? null })
      .catch(() => {});
  let image;
  try {
    image = await generateImage(llm, prompt, deps.fetchFn, { reference, aspect: '3:4' });
  } catch (err) {
    await log(false, (err as Error).message);
    throw err;
  }
  await log(true);
  const info = inspectImage(image.data);
  if (!info) throw new Error('圖片模型回傳的不是圖片');
  const rel = `${PHOTO_DIR}/${randomUUID()}.${info.ext}`;
  await writeFile(path.join(deps.mediaDir, rel), image.data);
  return { path: rel, mime: info.mime, width: info.width, height: info.height, description };
}
