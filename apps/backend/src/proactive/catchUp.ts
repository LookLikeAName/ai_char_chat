// 補上停機期間的主動訊息：遊戲沒開著的時候不會有人主動找你，所以啟動時把那段時間（最多 48 小時）
// 照平常的規則重新跑一次主動發話的檢查（每 15 分鐘一次：作息、勿擾時段、每日次數、上一則還沒回就不追…），
// 決定要傳的就用那個時間點的情境產生訊息，訊息的時間也是那個時間點，就像是那時候傳來的。
import { eq } from 'drizzle-orm';
import type { AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, systemState } from '../db/schema.ts';
import type { AgentJob } from '../jobs.ts';
import { logEvent } from '../observability.ts';
import { ReplyEngine, type ReplyEngineDeps } from '../reply/engine.ts';
import { proactiveTick } from './tick.ts';

/** 停機超過這麼久才補 */
export const CATCH_UP_MIN_GAP_MS = 30 * 60_000;
/** 最多補最近這麼久 */
export const CATCH_UP_MAX_MS = 48 * 3_600_000;
/** 一次最多補幾次主動發話（每次可能有好幾則訊息） */
export const CATCH_UP_MAX_SENDS = 8;
const TICK_MS = 15 * 60_000;
const STATE_ID = 1;

export async function lastWorkerSeen(db: Db): Promise<Date | null> {
  const [row] = await db.select().from(systemState).where(eq(systemState.id, STATE_ID));
  return row?.workerSeenAt ?? null;
}

export async function markWorkerSeen(db: Db, now = new Date()): Promise<void> {
  await db
    .insert(systemState)
    .values({ id: STATE_ID, workerSeenAt: now })
    .onConflictDoUpdate({ target: systemState.id, set: { workerSeenAt: now } });
}

export interface CatchUpResult {
  from: Date;
  to: Date;
  ticks: number;
  sent: { avatarId: string; conversationId: string; at: Date }[];
}

/** 這段停機要不要補、從哪裡開始補；不用補時回傳 null */
export function catchUpWindow(settings: AppSettings, seen: Date | null, now: Date): { from: Date; to: Date } | null {
  if (!seen || !settings.proactive.enabled || !settings.proactive.catchUp) return null;
  if (now.getTime() - seen.getTime() < CATCH_UP_MIN_GAP_MS) return null;
  return { from: new Date(Math.max(seen.getTime(), now.getTime() - CATCH_UP_MAX_MS)), to: now };
}

export async function catchUpProactive(
  deps: Omit<ReplyEngineDeps, 'now' | 'sleep' | 'backdate' | 'enqueue'>,
  settings: AppSettings,
  window: { from: Date; to: Date },
  opts: { random?: () => number; maxSends?: number } = {},
): Promise<CatchUpResult> {
  const random = opts.random ?? Math.random;
  const maxSends = opts.maxSends ?? CATCH_UP_MAX_SENDS;
  const { from, to } = window;
  // 模擬的時鐘：打字的時間也讓它往前走，訊息之間的間隔才自然
  let clock = from.getTime();
  const engine = new ReplyEngine({
    ...deps,
    // 過去的訊息不需要顯示「輸入中」
    events: { publish: async (e) => (e.type === 'typing' ? undefined : deps.events.publish(e)) },
    now: () => new Date(clock),
    sleep: async (ms) => void (clock += ms),
    random,
    backdate: true,
  });
  const createdAt = new Map((await deps.db.select({ id: avatars.id, at: avatars.createdAt }).from(avatars)).map((a) => [a.id, a.at]));
  const result: CatchUpResult = { from, to, ticks: 0, sent: [] };

  for (let t = from.getTime() + TICK_MS; t < to.getTime() && result.sent.length < maxSends; t += TICK_MS) {
    result.ticks++;
    const jobs: { job: AgentJob; at: number }[] = [];
    await proactiveTick(deps, settings, async (job, delay) => void jobs.push({ job, at: t + (delay ?? 0) }), {
      now: new Date(t),
      random,
      quiet: true,
    });
    for (const { job, at } of jobs.sort((a, b) => a.at - b.at)) {
      if (result.sent.length >= maxSends || at >= to.getTime()) break;
      if (job.kind !== 'proactive' && job.kind !== 'group.proactive') continue;
      // 那時候還不存在的 avatar 不會傳訊息
      if ((createdAt.get(job.avatarId)?.getTime() ?? Infinity) > at) continue;
      clock = at;
      const r =
        job.kind === 'proactive'
          ? await engine.handleProactive(job.conversationId)
          : await engine.handleGroupProactive(job.conversationId, job.avatarId);
      if (r === 'sent') result.sent.push({ avatarId: job.avatarId, conversationId: job.conversationId, at: new Date(at) });
    }
  }

  await deps.db
    .insert(systemState)
    .values({ id: STATE_ID, catchUp: { at: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(), sent: result.sent.length } })
    .onConflictDoUpdate({
      target: systemState.id,
      set: { catchUp: { at: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(), sent: result.sent.length } },
    });
  await logEvent({
    category: 'proactive',
    type: 'proactive.catchup',
    message: `補上停機期間（${from.toISOString()} ～ ${to.toISOString()}）的主動訊息：${result.sent.length} 次`,
    data: { ticks: result.ticks, sent: result.sent },
  });
  return result;
}
