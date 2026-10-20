// 回覆時怎麼處理對話裡的圖片：
// - avatar 的模型看得懂圖片：最新的幾張直接附上（太舊的用文字描述，省 token）
// - 看不懂：用系統工具模型（如果看得懂圖片）寫一段描述，存起來重複使用；都不行就告訴 avatar「看不到內容」
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { defaultVision, utilityBinding, type AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { llmProfiles, messages, type MessageImage } from '../db/schema.ts';
import { logEvent } from '../observability.ts';
import { callUtility } from '../persona/utility.ts';
import type { CallContext } from '../services/llmCall.ts';
import type { HistoryImages, HistoryMessage } from './prompt.ts';

/** 直接附上的圖片最多幾張（最新的） */
export const PROMPT_IMAGES = 3;
/** 只看最近這麼多則訊息裡的圖片 */
const IMAGE_WINDOW = 20;
/** 一次回覆最多替幾張圖片寫描述 */
const CAPTIONS_PER_REPLY = 2;

export type LoadedHistory = (HistoryMessage & { id: string; imageFile?: MessageImage })[];

export async function profileVision(db: Db, profileId: string | undefined): Promise<boolean> {
  if (!profileId) return false;
  const [p] = await db.select({ provider: llmProfiles.provider, vision: llmProfiles.vision }).from(llmProfiles).where(eq(llmProfiles.id, profileId));
  return p ? (p.vision ?? defaultVision(p.provider)) : false;
}

const CAPTION_PROMPT =
  '用一兩句繁體中文客觀描述這張圖片：有什麼人、物品、場景、動作，圖裡的文字照抄。不要評論，也不要說「這張圖片」。';

/** 替一張圖片寫描述並存起來；系統工具模型看不懂圖片時回傳 null */
async function caption(ctx: CallContext & { mediaDir: string }, settings: AppSettings, m: LoadedHistory[number]): Promise<string | null> {
  const binding = utilityBinding(settings, 'caption');
  if (!binding || !m.imageFile || !(await profileVision(ctx.db, binding.profileId))) return null;
  const data = await readFile(path.join(ctx.mediaDir, m.imageFile.path)).catch(() => null);
  if (!data) return null;
  const text = await callUtility(
    ctx,
    settings,
    {
      system: '你負責描述圖片。',
      messages: [{ role: 'user', content: [{ type: 'image', mime: m.imageFile.mime, data: data.toString('base64') }, { type: 'text', text: CAPTION_PROMPT }] }],
    },
    'image.caption',
    { json: false },
  );
  const result = text.trim().slice(0, 500);
  if (!result) return null;
  await ctx.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{image,caption}', to_jsonb(${result}::text))` })
    .where(eq(messages.id, m.id));
  await logEvent({ category: 'reply', type: 'image.caption', message: `替圖片寫了描述：${result}` });
  return result;
}

/**
 * 決定這次回覆要附上哪些圖片，並替需要的圖片補上描述（會直接改 history 裡的 caption）。
 * selfId：自己傳的照片不用附（它知道自己拍了什麼）。preview 時不呼叫 LLM。
 */
export async function prepareImages(
  ctx: CallContext & { mediaDir?: string },
  settings: AppSettings,
  history: LoadedHistory,
  opts: { selfId: string; canSee: boolean; preview?: boolean },
): Promise<HistoryImages> {
  const images: HistoryImages = new Map();
  const mediaDir = ctx.mediaDir;
  if (!mediaDir) return images;
  const candidates = history
    .slice(-IMAGE_WINDOW)
    .filter((m) => m.imageFile && !(m.senderType === 'avatar' && m.senderAvatarId === opts.selfId))
    .reverse();

  if (opts.canSee) {
    for (const m of candidates.slice(0, PROMPT_IMAGES)) {
      const data = await readFile(path.join(mediaDir, m.imageFile!.path)).catch(() => null);
      if (data) images.set(m, { mime: m.imageFile!.mime, data: data.toString('base64') });
    }
  }
  if (opts.preview) return images;
  // 沒附上、也還沒有描述的玩家圖片：補描述（avatar 傳的照片已經有生成時的描述）
  const needCaption = candidates.filter((m) => !images.has(m) && m.senderType === 'user' && !m.image?.caption).slice(0, CAPTIONS_PER_REPLY);
  for (const m of needCaption) {
    try {
      const text = await caption({ ...ctx, mediaDir }, settings, m);
      if (text) m.image = { ...m.image, caption: text };
    } catch (err) {
      await logEvent({ category: 'reply', type: 'image.caption', level: 'warn', message: `圖片描述失敗：${(err as Error).message}` });
    }
  }
  return images;
}
