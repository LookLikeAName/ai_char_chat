// 用量：每日上限（全域、每個 avatar）與統計。「今天」依設定的時區。
import { and, eq, gte, sql } from 'drizzle-orm';
import { QUOTA_EXEMPT_PURPOSES, type UsageSummaryDto, type UsageTotals } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, usageLog } from '../db/schema.ts';
import { loadSettings } from './settings.ts';

/** 超過每日上限：不重試，也不需要「失敗」的紅字，明天（或調高上限後）就好了 */
export class QuotaError extends Error {
  override readonly name = 'QuotaError';
  constructor(
    readonly scope: 'global' | 'avatar',
    message: string,
  ) {
    super(message);
  }
}

/** 當地時間今天 0 點（UTC 時刻） */
export function localDayStart(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)!.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - offset);
}

const tokens = sql<number>`coalesce(sum(${usageLog.inputTokens} + ${usageLog.outputTokens}), 0)::float8`;

export async function tokensSince(db: Db, since: Date, avatarId?: string): Promise<number> {
  const [row] = await db
    .select({ tokens })
    .from(usageLog)
    .where(and(gte(usageLog.createdAt, since), avatarId ? eq(usageLog.avatarId, avatarId) : undefined));
  return Number(row?.tokens ?? 0);
}

export interface QuotaStatus {
  globalTokens: number;
  globalLimit: number;
  avatarTokens: number;
  avatarLimit: number;
  /** 超過了哪一個；都沒超過為 null */
  over: 'global' | 'avatar' | null;
}

export async function quotaStatus(db: Db, avatarId: string | null | undefined, now = new Date()): Promise<QuotaStatus> {
  const settings = await loadSettings(db);
  const since = localDayStart(now, settings.timezone);
  const [globalTokens, avatarRow] = await Promise.all([
    tokensSince(db, since),
    avatarId
      ? db.select({ limit: avatars.dailyTokenLimit }).from(avatars).where(eq(avatars.id, avatarId)).then((r) => r[0])
      : undefined,
  ]);
  const avatarLimit = avatarRow?.limit ?? 0;
  const avatarTokens = avatarId && avatarLimit ? await tokensSince(db, since, avatarId) : 0;
  const globalLimit = settings.dailyTokenLimit;
  const over =
    globalLimit && globalTokens >= globalLimit ? 'global' : avatarLimit && avatarTokens >= avatarLimit ? 'avatar' : null;
  return { globalTokens, globalLimit, avatarTokens, avatarLimit, over };
}

/** 呼叫 LLM 前檢查；超過就丟 QuotaError */
export async function checkQuota(db: Db, purpose: string, avatarId: string | null | undefined, now = new Date()) {
  if (QUOTA_EXEMPT_PURPOSES.includes(purpose)) return;
  const q = await quotaStatus(db, avatarId, now);
  if (q.over === 'global') {
    throw new QuotaError('global', `今天的用量已達上限（${q.globalTokens.toLocaleString()}／${q.globalLimit.toLocaleString()} tokens），明天會自動恢復；要繼續可以到「設定 → 一般 → 費用」調高上限`);
  }
  if (q.over === 'avatar') {
    const [a] = await db.select({ name: avatars.name }).from(avatars).where(eq(avatars.id, avatarId!));
    throw new QuotaError('avatar', `${a?.name ?? 'avatar'} 今天的用量已達上限（${q.avatarTokens.toLocaleString()}／${q.avatarLimit.toLocaleString()} tokens），明天會自動恢復；可以到它的「大腦」設定調高上限`);
  }
}

/** 資訊面板：這個 avatar 今天用了多少 */
export async function avatarUsageToday(db: Db, avatarId: string, now = new Date()) {
  const settings = await loadSettings(db);
  const since = localDayStart(now, settings.timezone);
  const [[mine], globalTokens, [a]] = await Promise.all([
    db
      .select({ tokens, costUsd: sql<number>`coalesce(sum(${usageLog.costUsd}), 0)::float8` })
      .from(usageLog)
      .where(and(gte(usageLog.createdAt, since), eq(usageLog.avatarId, avatarId))),
    tokensSince(db, since),
    db.select({ limit: avatars.dailyTokenLimit }).from(avatars).where(eq(avatars.id, avatarId)),
  ]);
  return {
    tokens: Number(mine?.tokens ?? 0),
    costUsd: Number(mine?.costUsd ?? 0),
    limit: a?.limit ?? 0,
    globalTokens,
    globalLimit: settings.dailyTokenLimit,
  };
}

const totals = {
  calls: sql<number>`count(*)::int`,
  failed: sql<number>`(count(*) filter (where not ${usageLog.ok}))::int`,
  inputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)::float8`,
  outputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)::float8`,
  costUsd: sql<number>`coalesce(sum(${usageLog.costUsd}), 0)::float8`,
};

const EMPTY: UsageTotals = { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const num = <T extends UsageTotals>(r: T): T => ({
  ...r,
  calls: Number(r.calls),
  failed: Number(r.failed),
  inputTokens: Number(r.inputTokens),
  outputTokens: Number(r.outputTokens),
  costUsd: Number(r.costUsd),
});

/** 用量統計：最近 days 天（含今天） */
export async function usageSummary(db: Db, days: number, now = new Date()): Promise<UsageSummaryDto> {
  const settings = await loadSettings(db);
  const tz = settings.timezone;
  const todayStart = localDayStart(now, tz);
  const since = new Date(todayStart.getTime() - (days - 1) * 86_400_000);
  const inRange = gte(usageLog.createdAt, since);
  const localDate = sql<string>`to_char(${usageLog.createdAt} at time zone ${tz}, 'YYYY-MM-DD')`;

  const [today, total, daily, byAvatar, byPurpose, byModel, avatarRows] = await Promise.all([
    db.select(totals).from(usageLog).where(gte(usageLog.createdAt, todayStart)),
    db.select(totals).from(usageLog).where(inRange),
    // 時區是參數，select 與 group by 會變成不同的參數，所以用欄位順序分組
    db.select({ date: localDate, ...totals }).from(usageLog).where(inRange).groupBy(sql`1`),
    db
      .select({
        avatarId: usageLog.avatarId,
        todayTokens: sql<number>`coalesce(sum(${usageLog.inputTokens} + ${usageLog.outputTokens}) filter (where ${usageLog.createdAt} >= ${todayStart.toISOString()}::timestamptz), 0)::float8`,
        ...totals,
      })
      .from(usageLog)
      .where(inRange)
      .groupBy(usageLog.avatarId),
    db.select({ purpose: usageLog.purpose, ...totals }).from(usageLog).where(inRange).groupBy(usageLog.purpose),
    db
      .select({ model: usageLog.model, profileId: usageLog.profileId, ...totals })
      .from(usageLog)
      .where(inRange)
      .groupBy(usageLog.model, usageLog.profileId),
    db.select({ id: avatars.id, limit: avatars.dailyTokenLimit }).from(avatars),
  ]);

  // 每天都列出來（沒用量的日子補 0），圖表才不會跳過
  const byDate = new Map(daily.map((d) => [d.date, num(d)]));
  const dates: string[] = [];
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let i = days - 1; i >= 0; i--) dates.push(fmt.format(new Date(now.getTime() - i * 86_400_000)));
  const limits = new Map(avatarRows.map((a) => [a.id, a.limit]));
  const byTokens = <T extends UsageTotals>(a: T, b: T) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);

  return {
    days,
    today: { ...num(today[0] ?? EMPTY), limit: settings.dailyTokenLimit },
    total: num(total[0] ?? EMPTY),
    daily: [...new Set(dates)].map((date) => ({ ...(byDate.get(date) ?? EMPTY), date })),
    byAvatar: byAvatar
      .map((r) => ({ ...num(r), todayTokens: Number(r.todayTokens), limit: r.avatarId ? (limits.get(r.avatarId) ?? 0) : 0 }))
      .sort(byTokens),
    byPurpose: byPurpose.map(num).sort(byTokens),
    byModel: byModel.map(num).sort(byTokens),
  };
}
