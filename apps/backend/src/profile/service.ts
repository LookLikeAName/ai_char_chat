import { eq } from 'drizzle-orm';
import {
  cleanAnswers,
  scoreAll,
  type AllAnswers,
  type AppSettings,
  type InstrumentId,
  type Preferences,
  type ProfileDto,
} from '@acc/shared';
import type { Db } from '../db/client.ts';
import { userProfile } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { callUtility } from '../persona/utility.ts';
import type { CallContext } from '../services/llmCall.ts';
import { describePreferences, describeResults } from './describe.ts';

const PROFILE_ID = 1;
type Row = typeof userProfile.$inferSelect;

async function loadRow(db: Db): Promise<Row> {
  const [row] = await db.select().from(userProfile).where(eq(userProfile.id, PROFILE_ID));
  return row ?? { id: PROFILE_ID, preferences: null, answers: {}, summary: '', summaryAt: null, inputsUpdatedAt: null };
}

async function saveRow(db: Db, patch: Partial<Omit<Row, 'id'>>): Promise<void> {
  await db
    .insert(userProfile)
    .values({ id: PROFILE_ID, ...patch })
    .onConflictDoUpdate({ target: userProfile.id, set: patch });
}

function toDto(row: Row): ProfileDto {
  return {
    preferences: row.preferences,
    answers: row.answers,
    results: scoreAll(row.answers),
    summary: row.summary,
    summaryAt: row.summaryAt?.toISOString() ?? null,
    summaryStale: !!row.summary && !!row.inputsUpdatedAt && (!row.summaryAt || row.inputsUpdatedAt > row.summaryAt),
  };
}

export async function loadProfile(db: Db): Promise<ProfileDto> {
  return toDto(await loadRow(db));
}

export async function savePreferences(db: Db, preferences: Preferences): Promise<ProfileDto> {
  await saveRow(db, { preferences, inputsUpdatedAt: new Date() });
  return loadProfile(db);
}

/** 合併作答；值為 null 表示清除那一題 */
export async function patchAnswers(
  db: Db,
  instrument: InstrumentId,
  patch: Record<string, number | null>,
): Promise<ProfileDto> {
  const row = await loadRow(db);
  const merged: Record<string, number | null> = { ...(row.answers[instrument] ?? {}), ...patch };
  const answers: AllAnswers = {
    ...row.answers,
    [instrument]: cleanAnswers(
      instrument,
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null)),
    ),
  };
  await saveRow(db, { answers, inputsUpdatedAt: new Date() });
  return loadProfile(db);
}

export async function setSummary(db: Db, summary: string): Promise<ProfileDto> {
  await saveRow(db, { summary, summaryAt: new Date() });
  return loadProfile(db);
}

const SUMMARY_SYSTEM = `你是溫和、細心的心理學背景撰稿人。你要根據玩家的自我描述與心理測驗結果，替一款聊天遊戲的 AI 角色寫一段「關於這位玩家」的參考說明，讓角色知道怎麼和他自然相處。
這不是診斷：用日常語言描述傾向，不要貼標籤、不要提到分數、量表名稱或心理學術語。`;

/** 請系統工具模型寫摘要 */
export async function generateSummary(ctx: CallContext, settings: AppSettings): Promise<ProfileDto> {
  const row = await loadRow(ctx.db);
  if (!row.preferences) throw new HttpError(400, '請先填寫偏好問卷');
  const results = describeResults(scoreAll(row.answers));
  const content = `# 玩家的自我描述
${describePreferences(row.preferences).join('\n')}

# 心理測驗結果
${results.length ? results.join('\n') : '（還沒做測驗）'}

# 請寫一段 250～400 字的繁體中文說明，以「這位玩家」稱呼，涵蓋：
- 個性與給人的感覺
- 喜歡怎麼聊天、怎麼被對待（例如需要多少回應、喜歡直接還是委婉）
- 在親近關係裡的需求與可能的不安
- 重視的事情
- 相處時要注意的地方
只輸出說明本文，不要標題或條列。`;
  const text = await callUtility(ctx, settings, { system: SUMMARY_SYSTEM, messages: [{ role: 'user', content }] }, 'profile.summary', {
    json: false,
  });
  const summary = text.trim().slice(0, 3000);
  if (!summary) throw new HttpError(502, '系統工具模型沒有回傳內容');
  return setSummary(ctx.db, summary);
}
