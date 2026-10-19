// avatar 傳照片：照它寫的描述，用「設定 → 一般 → 頭像與照片生成」的圖片模型生成。
// 每個 avatar 自己決定照片裡怎麼出現（自己入鏡、用娃娃之類的代替、不入鏡），以及用哪張參考圖
// （頭像、另外上傳的、或不用），參考圖讓入鏡的人或東西每張都長得一樣。
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gte, sql } from 'drizzle-orm';
import { IMAGE_STYLES, imageModelSupportsReference, type AppSettings, type AvatarPhoto, type ImageStyle } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { avatars, messages, usageLog, type MessageImage } from '../db/schema.ts';
import { generateImage } from '../images/generate.ts';
import { inspectImage } from '../images/inspect.ts';
import type { FetchFn } from '../llm/index.ts';
import { avatarPhoto } from './avatars.ts';
import { getProfile, resolveRow } from './llmProfiles.ts';
import { localDayStart, quotaStatus } from './usage.ts';

export const PHOTO_DIR = 'photos';

/** 今天還能傳幾張；不能傳照片（沒設定圖片模型、全域或這個 avatar 關掉了、超過用量上限）時回傳 null */
export async function photosRemaining(
  db: Db,
  settings: AppSettings,
  avatarId: string,
  opts: { mediaDir?: string; now?: Date } = {},
): Promise<number | null> {
  if (!opts.mediaDir || !settings.imageGen || !settings.photos.enabled) return null;
  const [a] = await db.select({ photo: avatars.photo }).from(avatars).where(eq(avatars.id, avatarId));
  if (!a || !avatarPhoto(a).enabled) return null;
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
  opts: { photo: AvatarPhoto; style: ImageStyle; adult: boolean; hasReference: boolean },
): string {
  const b = avatar.persona.basic ?? {};
  const ref = opts.hasReference;
  let subject = '';
  if (opts.photo.appears === 'self') {
    const self = [b.age ? `${b.age} 歲` : '', b.gender ?? '', b.appearance ? `外貌：${b.appearance}` : '', b.style ? `穿著風格：${b.style}` : '']
      .filter(Boolean)
      .join('，');
    if (self || ref) subject = `如果畫面裡有拍照的人自己（例如自拍）：${self}${ref ? `${self ? '；' : ''}長相要和參考圖裡的人是同一個人` : ''}。`;
  } else if (opts.photo.appears === 'proxy') {
    const proxy = opts.photo.proxy || (ref ? '參考圖裡的東西' : '一個玩偶');
    subject = `拍照的人自己不會出現在照片裡（不要拍到臉）。照片裡要「代替自己」入鏡時，出現的是${proxy}${ref ? '，外觀要和參考圖裡的一樣' : ''}。`;
  } else {
    subject = '拍照的人自己不會出現在照片裡，不要拍到人的臉（頂多入鏡一隻手）。';
  }
  return [
    '一張用手機拍的照片，像是傳訊息給朋友看的生活照：自然、隨手拍的感覺，沒有文字、浮水印或邊框。',
    `畫面：${description}`,
    subject,
    `風格：${IMAGE_STYLES[opts.style]}。`,
    opts.adult ? '' : '非裸露、適合一般場合。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 依 avatar 的設定選參考圖；圖片模型不支援參考圖時不給 */
async function referenceImage(mediaDir: string, avatar: typeof avatars.$inferSelect, photo: AvatarPhoto, provider: string, model: string) {
  if (!imageModelSupportsReference(provider, model)) return null;
  const file = photo.reference === 'avatar' ? avatar.imagePath : photo.reference === 'custom' ? avatar.photoReferencePath : null;
  if (!file) return null;
  const data = await readFile(path.join(mediaDir, file)).catch(() => null);
  const info = data && inspectImage(data);
  return data && info ? { mime: info.mime, data } : null;
}

export async function takePhoto(
  deps: { db: Db; box: SecretBox; mediaDir: string; fetchFn?: FetchFn },
  settings: AppSettings,
  avatar: typeof avatars.$inferSelect,
  description: string,
): Promise<MessageImage> {
  const gen = settings.imageGen!;
  const profile = await getProfile(deps.db, gen.profileId);
  const llm = resolveRow(profile, deps.box);
  const photo = avatarPhoto(avatar);
  const reference = await referenceImage(deps.mediaDir, avatar, photo, llm.provider, llm.model);
  const prompt = photoPrompt(avatar, description, {
    photo,
    style: photo.style ?? settings.photos.style,
    adult: settings.adultContent,
    hasReference: !!reference,
  });

  const started = Date.now();
  const log = (ok: boolean, error?: string) =>
    deps.db
      .insert(usageLog)
      .values({ purpose: 'photo.generate', avatarId: avatar.id, profileId: profile.id, model: profile.model, latencyMs: Date.now() - started, ok, error: error?.slice(0, 500) ?? null })
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
