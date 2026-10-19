// 每天的生活日誌：依作息與人格設定，替 avatar 編出「今天會發生的幾件事」。
import { and, eq } from 'drizzle-orm';
import { localClock, type AppSettings, type LifeLogEvent } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, lifeLogs } from '../db/schema.ts';
import { renderPersona } from '../persona/describe.ts';
import { callUtility, parseJsonObject } from '../persona/utility.ts';
import { completePersona } from '../reply/prompt.ts';
import { logEvent } from '../observability.ts';
import type { CallContext } from '../services/llmCall.ts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getLifeLog(db: Db, avatarId: string, date: string): Promise<LifeLogEvent[] | null> {
  const [row] = await db
    .select()
    .from(lifeLogs)
    .where(and(eq(lifeLogs.avatarId, avatarId), eq(lifeLogs.date, date)));
  return row?.events ?? null;
}

/** 今天還沒有日誌就產生一份；沒有系統工具模型或人格設定時略過 */
export async function ensureLifeLog(
  ctx: CallContext,
  settings: AppSettings,
  avatar: typeof avatars.$inferSelect,
  now = new Date(),
): Promise<LifeLogEvent[] | null> {
  const { date, weekend } = localClock(now, settings.timezone);
  const existing = await getLifeLog(ctx.db, avatar.id, date);
  if (existing || !settings.utilityLlm) return existing;
  const persona = completePersona(avatar.persona);
  if (!persona) return null;

  const content = `# 角色：${avatar.name}
${renderPersona(persona, ['relationship.withUser', 'relationship.callsUser'])}

# 任務
今天是 ${date}（${weekend ? '假日' : '平日'}）。照這個角色的作息與個性，編出他今天會發生的 4～7 件事（可以是小事：吃了什麼、工作上遇到的人、看到的東西、心情的起伏）。
- 時間要符合今天的作息（${weekend ? '假日' : '平日'}那一組），用 24 小時制 HH:MM，由早到晚。
- 具體、有生活感，偶爾有點小插曲；不要每件都很戲劇化。
- 用繁體中文，第一人稱，一句話一件。

# 輸出格式
{"events": [{"time": "08:10", "text": "…"}]}`;

  const text = await callUtility(ctx, settings, { system: '你在替角色安排生活。只輸出 JSON。', messages: [{ role: 'user', content }] }, 'life.log', { avatarId: avatar.id });
  const out = parseJsonObject(text);
  const events = (Array.isArray(out?.events) ? out.events : [])
    .filter(
      (e): e is LifeLogEvent =>
        !!e && typeof (e as LifeLogEvent).time === 'string' && HHMM.test((e as LifeLogEvent).time) && typeof (e as LifeLogEvent).text === 'string',
    )
    .map((e) => ({ time: e.time, text: e.text.trim().slice(0, 200) }))
    .filter((e) => e.text)
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(0, 10);
  if (!events.length) return null;
  await ctx.db.insert(lifeLogs).values({ avatarId: avatar.id, date, events }).onConflictDoNothing();
  await logEvent({
    category: 'life',
    type: 'life.generated',
    avatarId: avatar.id,
    message: `${avatar.name}：產生了 ${date} 的生活日誌（${events.length} 件事）`,
    data: { events },
  });
  return (await getLifeLog(ctx.db, avatar.id, date)) ?? events;
}
