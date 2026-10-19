// 一對一回覆流程（worker 執行）。
//
// 核心規則是「回覆還沒回的訊息」，所以重複觸發是安全的：
// 每則玩家訊息都會投遞一個工作，但真正產生回覆的只有拿到鎖、而且發現有未回訊息的那一個。
//
//   拿鎖 → 找出最新的玩家訊息（快照）→ 標記已讀 → 停頓 → 輸入中 → 呼叫 LLM
//        → 逐則「打字」後送出 → 標記已回覆到快照 → 再檢查一次有沒有新訊息
//
// 產生或打字期間玩家又傳了訊息：還沒送出任何一則就整輪重來（連同新訊息一起回）；
// 已經送出幾則就停在這裡，下一輪再回新訊息。
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import {
  addressesEveryone,
  availabilityAt,
  chooseSpeakers,
  GROUP_MESSAGE_BUDGET,
  localClock,
  mentions,
  STAGE_LABELS,
  type AppSettings,
  type SpeakerCandidate,
  type AvatarLink,
} from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { avatars, avatarState, conversationMembers, conversations, messages, relationships } from '../db/schema.ts';
import type { EventPublisher } from '../events/bus.ts';
import { loggedContent } from '../llm/content.ts';
import type { FetchFn } from '../llm/index.ts';
import { getLifeLog } from '../life/lifeLog.ts';
import type { AgentJob } from '../jobs.ts';
import type { Lock } from '../lock.ts';
import { embedderFromSettings } from '../memory/embedder.ts';
import { bigramSimilarity, latestImpression, retrieveMemories } from '../memory/store.ts';
import { attachParsed, logEvent, withScope } from '../observability.ts';
import { loadProfile } from '../profile/service.ts';
import { applyInteraction, getMood, getRelationship, growFamiliarity, setMood } from '../relationship/service.ts';
import { callWithBinding } from '../services/llmCall.ts';
import { QuotaError, quotaStatus } from '../services/usage.ts';
import { postMessage } from '../services/messages.ts';
import { linkedAvatars, loadLinks } from '../services/avatarLinks.ts';
import { avatarPhoto } from '../services/avatars.ts';
import { photosRemaining, takePhoto } from '../services/photos.ts';
import { loadSettings } from '../services/settings.ts';
import { parseReplyOutput, plainTextFallback, type ReplyOutput } from './output.ts';
import { buildReplyPrompt, formatGap, type HistoryMessage, type PromptGroup, type PromptSituation } from './prompt.ts';
import { prepareImages, profileVision, type LoadedHistory } from './images.ts';
import { ACTIVE_WINDOW_MS } from './planner.ts';
import { betweenMessagesMs, readPauseMs, typingMs, type Random } from './timing.ts';

export interface ReplyEngineDeps {
  db: Db;
  box: SecretBox;
  events: EventPublisher;
  lock: Lock;
  /** 回覆完成後呼叫（排程記憶萃取） */
  onReplied?: (avatarId: string, conversationId: string) => Promise<void>;
  /** 群組：玩家還在打字時，延後這一輪 */
  enqueue?: (job: AgentJob, delayMs: number) => Promise<void>;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  random?: Random;
  now?: () => Date;
  /** 聊天圖片與 avatar 照片的檔案位置；沒給時不處理圖片 */
  mediaDir?: string;
}

type Outcome = { kind: 'restart' } | { kind: 'sent' | 'interrupted'; output: ReplyOutput };

interface Ctx {
  conversationId: string;
  type: 'dm' | 'group';
  avatar: typeof avatars.$inferSelect;
  handledUpTo: Date | null;
  seenUpTo: Date | null;
  replyDueAt: Date | null;
  replyReason: PromptSituation['reason'] | null;
}

const LOCK_TTL_MS = 3 * 60 * 1000;
/** 玩家一直連續傳訊息時，一次工作最多重來幾輪；剩下的交給後面的工作 */
const MAX_ROUNDS = 4;
const HISTORY_LOAD = 120;

/** 群組：玩家最後一次打字後這麼久內，當作還在打字 */
const TYPING_GRACE_MS = 3000;

const FORMAT_REMINDER = '（系統提醒：上一次的輸出不是指定的 JSON。請只輸出 {"inner_thought": "...", "messages": ["..."]}。）';

export class ReplyEngine {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: Random;
  private readonly now: () => Date;

  constructor(private readonly deps: ReplyEngineDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 'busy'：另一個流程正在處理這個對話，呼叫端應該稍後再試。
   * 'early'：還沒到預計看到訊息的時間（之後排定的工作會處理）。force 會忽略預計時間（重試用）。
   */
  async handle(conversationId: string, opts: { force?: boolean } = {}): Promise<'busy' | 'done' | 'early'> {
    return withScope({ conversationId }, () => this.handleInner(conversationId, opts));
  }

  private async handleInner(conversationId: string, opts: { force?: boolean }): Promise<'busy' | 'done' | 'early'> {
    const key = `reply:${conversationId}`;
    const token = await this.deps.lock.acquire(key, LOCK_TTL_MS);
    if (!token) return 'busy';
    let typingAvatar: string | null = null;
    const setTyping = async (avatarId: string, typing: boolean) => {
      typingAvatar = typing ? avatarId : null;
      await this.deps.events.publish({ type: 'typing', conversationId, avatarId, typing });
    };
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const ctx = await this.loadContext(conversationId);
        if (!ctx) return 'done';
        const snapshot = await this.latestUserMessageAt(conversationId);
        if (!snapshot || (ctx.handledUpTo && snapshot <= ctx.handledUpTo)) return 'done';
        const now = this.now();
        if (round === 0 && !opts.force && ctx.replyDueAt && now.getTime() < ctx.replyDueAt.getTime() - 1000) {
          await logEvent({
            category: 'reply',
            type: 'reply.early',
            level: 'debug',
            avatarId: ctx.avatar.id,
            message: `${ctx.avatar.name}：還沒到預計看到的時間（${ctx.replyDueAt.toISOString()}），先不處理`,
            data: { dueAt: ctx.replyDueAt.toISOString(), reason: ctx.replyReason },
          });
          return 'early';
        }

        if (!ctx.avatar.llm) {
          await this.noticeOnce(
            conversationId,
            `${ctx.avatar.name} 還沒有設定大腦（LLM）。到 avatar 設定頁綁定一個 LLM 設定檔後，就能開始回覆。`,
          );
          await this.markHandled(ctx, snapshot);
          return 'done';
        }
        // 超過每日上限：先不回（不標記處理過），調高上限後按「重試」或再傳一則就會回
        if (await this.overQuota(conversationId, ctx.avatar, true)) return 'done';

        // 第一輪才有「怎麼看到訊息」的情境；之後是正在聊天中
        const situation: PromptSituation =
          round === 0
            ? { mode: 'reply', reason: ctx.replyReason ?? 'normal', waitedMs: await this.waitedMs(ctx, now) }
            : { mode: 'reply', reason: 'normal' };
        await this.markSeen(ctx, snapshot);
        await logEvent({
          category: 'reply',
          type: 'reply.seen',
          avatarId: ctx.avatar.id,
          message: `${ctx.avatar.name} 看到訊息${round === 0 && situation.reason !== 'normal' ? `（${situation.reason}，等了 ${Math.round((situation.waitedMs ?? 0) / 60_000)} 分鐘）` : ''}，開始回覆`,
          data: { round, situation, forced: !!opts.force },
        });
        const outcome = await this.generateAndSend(ctx, snapshot, setTyping, situation);
        if (outcome.kind === 'restart') {
          await logEvent({
            category: 'reply',
            type: 'reply.restart',
            avatarId: ctx.avatar.id,
            message: `${ctx.avatar.name}：玩家在回覆送出前又傳了訊息，整輪重來`,
          });
          continue;
        }
        await logEvent({
          category: 'reply',
          type: outcome.kind === 'sent' ? 'reply.sent' : 'reply.interrupted',
          avatarId: ctx.avatar.id,
          traceId: outcome.output.traceId,
          message:
            outcome.kind === 'sent'
              ? `${ctx.avatar.name} 回了 ${outcome.output.messages.length} 則`
              : `${ctx.avatar.name}：送出途中玩家插話，停在這裡，下一輪回新訊息`,
          data: { messages: outcome.output.messages },
        });
        await this.markHandled(ctx, snapshot);
        await this.applyState(ctx, outcome.output);
        await this.deps.onReplied?.(ctx.avatar.id, ctx.conversationId);
      }
      return 'done';
    } finally {
      if (typingAvatar) await setTyping(typingAvatar, false).catch(() => {});
      await this.deps.lock.release(key, token);
    }
  }

  /**
   * 主動傳訊息給玩家。玩家有還沒回的訊息時不做（交給回覆流程）；模型可以決定這次不說話。
   * 回傳 'sent' 時，至少送出了一則。
   */
  async handleProactive(conversationId: string): Promise<'busy' | 'skipped' | 'sent'> {
    return withScope({ conversationId }, () => this.handleProactiveInner(conversationId));
  }

  private async handleProactiveInner(conversationId: string): Promise<'busy' | 'skipped' | 'sent'> {
    const key = `reply:${conversationId}`;
    const token = await this.deps.lock.acquire(key, LOCK_TTL_MS);
    if (!token) return 'busy';
    let typing: string | null = null;
    const setTyping = async (avatarId: string, on: boolean) => {
      typing = on ? avatarId : null;
      await this.deps.events.publish({ type: 'typing', conversationId, avatarId, typing: on });
    };
    try {
      const ctx = await this.loadContext(conversationId);
      if (!ctx?.avatar.llm) return 'skipped';
      const latestUser = await this.latestUserMessageAt(conversationId);
      if (latestUser && (!ctx.handledUpTo || latestUser > ctx.handledUpTo)) return 'skipped';
      if (await this.overQuota(conversationId, ctx.avatar, false)) return 'skipped';

      const startedAt = this.now();
      const output = await this.generate(ctx, { mode: 'proactive' });
      if (!output.messages.length && !output.photo) {
        await logEvent({
          category: 'proactive',
          type: 'proactive.silent',
          avatarId: ctx.avatar.id,
          traceId: output.traceId,
          message: `${ctx.avatar.name} 想了想，這次決定不傳訊息`,
        });
        return 'skipped';
      }
      let sent = 0;
      for (const [i, text] of output.messages.entries()) {
        await setTyping(ctx.avatar.id, true);
        await this.sleep(typingMs(text, this.random, ctx.avatar.persona.speech?.typingSpeed));
        // 玩家剛好傳了訊息：停下來，交給回覆流程
        if (await this.hasNewerUserMessage(conversationId, latestUser ?? startedAt)) break;
        await postMessage(this.deps.db, this.deps.events, {
          conversationId,
          senderType: 'avatar',
          senderAvatarId: ctx.avatar.id,
          content: text,
          meta: {
            proactive: true,
            ...(output.traceId ? { traceId: output.traceId } : {}),
            ...(i === 0 && output.innerThought ? { innerThought: output.innerThought } : {}),
          },
        });
        sent++;
        await setTyping(ctx.avatar.id, false);
        if (i < output.messages.length - 1) await this.sleep(betweenMessagesMs(this.random));
      }
      if (output.photo && !(await this.hasNewerUserMessage(conversationId, latestUser ?? startedAt))) {
        if (await this.sendPhoto(ctx, output, { proactive: true })) sent++;
      }
      if (!sent) return 'skipped';
      await logEvent({
        category: 'proactive',
        type: 'proactive.sent',
        avatarId: ctx.avatar.id,
        traceId: output.traceId,
        message: `${ctx.avatar.name} 主動傳了 ${sent} 則訊息`,
        data: { messages: output.messages.slice(0, sent) },
      });
      await this.bumpProactiveCount(ctx.avatar.id);
      await this.applyState(ctx, output);
      await this.deps.onReplied?.(ctx.avatar.id, conversationId);
      return 'sent';
    } finally {
      if (typing) await setTyping(typing, false).catch(() => {});
      await this.deps.lock.release(key, token);
    }
  }

  private async bumpProactiveCount(avatarId: string): Promise<void> {
    const { timezone } = await loadSettings(this.deps.db);
    const date = localClock(this.now(), timezone).date;
    await this.deps.db
      .insert(avatarState)
      .values({ avatarId, mood: { label: '平常', valence: 0, energy: 0 }, proactiveDate: date, proactiveCount: 1 })
      .onConflictDoUpdate({
        target: avatarState.avatarId,
        set: {
          proactiveCount: sql`case when ${avatarState.proactiveDate} = ${date} then ${avatarState.proactiveCount} + 1 else 1 end`,
          proactiveDate: date,
        },
      });
  }

  /** 玩家第一則還沒讀的訊息，到現在過了多久 */
  private async waitedMs(ctx: Ctx, now: Date): Promise<number> {
    const [first] = await this.deps.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, ctx.conversationId),
          eq(messages.senderType, 'user'),
          ctx.seenUpTo ? gt(messages.createdAt, ctx.seenUpTo) : undefined,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1);
    return first ? Math.max(0, now.getTime() - first.createdAt.getTime()) : 0;
  }

  /**
   * 群組的一輪：玩家發話（並停止打字）後，決定誰回、依序產生。
   * 後回的人看得到前面的人說了什麼；一輪最多 GROUP_MESSAGE_BUDGET 則；回覆裡點名的人會接著回。
   */
  async handleGroupTurn(conversationId: string, opts: { force?: boolean } = {}): Promise<'busy' | 'done' | 'early'> {
    return withScope({ conversationId }, () => this.groupTurnInner(conversationId, opts));
  }

  private async groupTurnInner(conversationId: string, opts: { force?: boolean }): Promise<'busy' | 'done' | 'early'> {
    const db = this.deps.db;
    const key = `group:${conversationId}`;
    const token = await this.deps.lock.acquire(key, LOCK_TTL_MS);
    if (!token) return 'busy';
    let typing: string | null = null;
    const setTyping = async (avatarId: string, on: boolean) => {
      typing = on ? avatarId : null;
      await this.deps.events.publish({ type: 'typing', conversationId, avatarId, typing: on });
    };
    try {
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
      if (!conv || conv.type !== 'group') return 'done';
      const now = this.now();
      if (!opts.force && conv.turnDueAt && now.getTime() < conv.turnDueAt.getTime() - 500) return 'early';
      // 玩家還在打字：等他打完
      if (!opts.force && conv.userTypingAt && now.getTime() - conv.userTypingAt.getTime() < TYPING_GRACE_MS && this.deps.enqueue) {
        await db.update(conversations).set({ turnDueAt: new Date(now.getTime() + TYPING_GRACE_MS) }).where(eq(conversations.id, conversationId));
        await this.deps.enqueue({ kind: 'group.turn', conversationId }, TYPING_GRACE_MS);
        await logEvent({ category: 'group', type: 'group.wait', level: 'debug', message: '玩家還在打字，這一輪延後 3 秒' });
        return 'early';
      }
      const snapshot = await this.latestUserMessageAt(conversationId);
      if (!snapshot || (conv.handledUpTo && snapshot <= conv.handledUpTo)) return 'done';

      const unanswered = await db
        .select({ content: messages.content })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.senderType, 'user'),
            conv.handledUpTo ? gt(messages.createdAt, conv.handledUpTo) : undefined,
          ),
        );
      const text = unanswered.map((m) => m.content).join('\n');
      const settings = await loadSettings(db);
      const globalQuota = await quotaStatus(db, null, now);
      if (globalQuota.over) {
        await this.quotaNotice(conversationId, null, 'global');
        return 'done';
      }
      const memberRows = await db
        .select({ avatar: avatars })
        .from(conversationMembers)
        .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
        .where(eq(conversationMembers.conversationId, conversationId));
      const recent = await db
        .select({ senderType: messages.senderType, senderAvatarId: messages.senderAvatarId, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt), desc(messages.seq))
        .limit(10);

      const candidates: SpeakerCandidate[] = [];
      for (const { avatar } of memberRows) {
        if (!avatar.llm) continue;
        // 超過自己的每日上限：這一輪不參加
        if ((await quotaStatus(db, avatar.id, now)).over) {
          await logEvent({ category: 'usage', type: 'usage.quota', level: 'warn', avatarId: avatar.id, message: `${avatar.name} 今天的用量已達上限，這一輪不回` });
          continue;
        }
        const rel = await getRelationship(db, avatar.id);
        const p = avatar.persona;
        const interests = [p.preferences?.hobbies, p.preferences?.likes, p.preferences?.favoriteTopics, [p.basic?.occupation ?? '']]
          .flat()
          .filter(Boolean)
          .join('、');
        // 剛在群組裡說過話：正在聊天，當作在線
        const chatting = recent.some(
          (m) => m.senderAvatarId === avatar.id && now.getTime() - m.createdAt.getTime() < ACTIVE_WINDOW_MS,
        );
        const a = chatting ? { status: 'free' as const } : availabilityAt(p, now, settings.timezone);
        candidates.push({
          id: avatar.id,
          name: avatar.name,
          status: a.status,
          extraversion: p.personality?.bigFive?.extraversion ?? 50,
          affinity: rel.affinity,
          relevance: interests ? Math.min(1, bigramSimilarity(text, interests) * 4) : 0,
          recentMessages: recent.filter((m) => m.senderAvatarId === avatar.id).length,
          mentioned: mentions(text, avatar.name),
        });
      }
      const scored = chooseSpeakers(candidates, { random: this.random, forceOne: addressesEveryone(text) });
      const queue = scored.filter((c) => c.chosen);
      await logEvent({
        category: 'group',
        type: 'group.turn',
        message: `群組「${conv.title ?? ''}」：${queue.length ? `${queue.map((c) => c.name).join('、')} 要回` : '這一輪沒人回'}`,
        data: {
          text,
          candidates: scored.map((c) => ({
            name: c.name,
            score: Math.round(c.score * 100) / 100,
            chosen: c.chosen,
            why: c.why,
            status: c.status,
            relevance: Math.round(c.relevance * 100) / 100,
            mentioned: c.mentioned,
          })),
        },
      });

      let budget = GROUP_MESSAGE_BUDGET;
      const spoken: string[] = [];
      let interrupted = false;
      while (queue.length && budget > 0 && !interrupted) {
        if (await this.hasNewerUserMessage(conversationId, snapshot)) {
          interrupted = true;
          break;
        }
        const cand = queue.shift()!;
        const ctx = await this.loadContext(conversationId, cand.id);
        if (!ctx) continue;
        await this.markSeen(ctx, snapshot);
        await this.sleep(readPauseMs(this.random));
        await setTyping(cand.id, true);
        let output: Awaited<ReturnType<typeof this.generate>>;
        try {
          output = await this.generate(ctx, { mode: 'group', mentioned: cand.mentioned, before: [...spoken] });
        } catch (err) {
          // 這一輪中途用完了上限：換下一個人（全域上限用完的話，下一個人也會停在這裡）
          if (!(err instanceof QuotaError)) throw err;
          await setTyping(cand.id, false);
          if (err.scope === 'global') {
            await this.quotaNotice(conversationId, null, 'global');
            break;
          }
          continue;
        }
        if (!output.messages.length && !output.photo) {
          await setTyping(cand.id, false);
          await logEvent({
            category: 'group',
            type: 'group.silent',
            avatarId: cand.id,
            traceId: output.traceId,
            message: `${cand.name}：看了訊息，這次決定不說話`,
          });
          continue;
        }
        const toSend = output.messages.slice(0, budget);
        let sent = 0;
        for (const [i, msg] of toSend.entries()) {
          if (i > 0) await setTyping(cand.id, true);
          await this.sleep(typingMs(msg, this.random, ctx.avatar.persona.speech?.typingSpeed));
          if (await this.hasNewerUserMessage(conversationId, snapshot)) {
            interrupted = true;
            break;
          }
          await postMessage(db, this.deps.events, {
            conversationId,
            senderType: 'avatar',
            senderAvatarId: cand.id,
            content: msg,
            meta: {
              ...(output.traceId ? { traceId: output.traceId } : {}),
              ...(i === 0 && output.innerThought ? { innerThought: output.innerThought } : {}),
            },
          });
          sent++;
          budget--;
          await setTyping(cand.id, false);
          if (i < toSend.length - 1) await this.sleep(betweenMessagesMs(this.random));
        }
        await setTyping(cand.id, false);
        if (!interrupted && output.photo && (await this.sendPhoto(ctx, output))) sent++;
        if (!sent) break;
        spoken.push(cand.name);
        await logEvent({
          category: 'group',
          type: 'group.sent',
          avatarId: cand.id,
          traceId: output.traceId,
          message: `${cand.name} 在群組回了 ${sent} 則（這一輪還剩 ${budget} 則）`,
          data: { messages: toSend.slice(0, sent) },
        });
        await this.applyState(ctx, output);
        await this.deps.onReplied?.(cand.id, conversationId);
        // 回覆裡點名了其他成員：額度還夠就讓他接著回
        const said = toSend.slice(0, sent).join('\n');
        for (const other of scored) {
          if (other.id === cand.id || other.status === 'sleep' || spoken.includes(other.name)) continue;
          if (queue.some((q) => q.id === other.id) || !mentions(said, other.name)) continue;
          queue.push({ ...other, mentioned: true, chosen: true, why: `被${cand.name}點名` });
          await logEvent({ category: 'group', type: 'group.chain', avatarId: other.id, message: `${cand.name} 點名了 ${other.name}，讓他接著回` });
        }
      }
      if (interrupted) {
        await logEvent({ category: 'group', type: 'group.interrupted', message: '玩家又發話了，這一輪停在這裡，下一輪接著回' });
      }

      // 沒在睡覺的成員都算看過了
      for (const c of scored) {
        if (c.status === 'sleep') continue;
        await db
          .update(conversationMembers)
          .set({ seenUpTo: snapshot })
          .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.avatarId, c.id)));
      }
      await db
        .update(conversations)
        .set({ handledUpTo: snapshot, turnDueAt: null })
        .where(eq(conversations.id, conversationId));
      await this.deps.events.publish({ type: 'conversations.changed' });
      return 'done';
    } finally {
      if (typing) await setTyping(typing, false).catch(() => {});
      await this.deps.lock.release(key, token);
    }
  }

  /** 群組：某個 avatar 主動開話題（其他人等玩家回應才會接話） */
  async handleGroupProactive(conversationId: string, avatarId: string): Promise<'busy' | 'skipped' | 'sent'> {
    return withScope({ conversationId, avatarId }, async () => {
      const key = `group:${conversationId}`;
      const token = await this.deps.lock.acquire(key, LOCK_TTL_MS);
      if (!token) return 'busy';
      try {
        const db = this.deps.db;
        const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
        const ctx = await this.loadContext(conversationId, avatarId);
        if (!conv || conv.type !== 'group' || !ctx?.avatar.llm) return 'skipped';
        const latestUser = await this.latestUserMessageAt(conversationId);
        if (latestUser && (!conv.handledUpTo || latestUser > conv.handledUpTo)) return 'skipped';
        if (await this.overQuota(conversationId, ctx.avatar, false)) return 'skipped';
        const output = await this.generate(ctx, { mode: 'proactive' });
        if (!output.messages.length && !output.photo) return 'skipped';
        let sent = 0;
        for (const [i, text] of output.messages.slice(0, 3).entries()) {
          await this.deps.events.publish({ type: 'typing', conversationId, avatarId, typing: true });
          await this.sleep(typingMs(text, this.random, ctx.avatar.persona.speech?.typingSpeed));
          await postMessage(db, this.deps.events, {
            conversationId,
            senderType: 'avatar',
            senderAvatarId: avatarId,
            content: text,
            meta: {
              proactive: true,
              ...(output.traceId ? { traceId: output.traceId } : {}),
              ...(i === 0 && output.innerThought ? { innerThought: output.innerThought } : {}),
            },
          });
          await this.deps.events.publish({ type: 'typing', conversationId, avatarId, typing: false });
          sent++;
        }
        if (output.photo && (await this.sendPhoto(ctx, output, { proactive: true }))) sent++;
        await logEvent({
          category: 'proactive',
          type: 'proactive.group',
          traceId: output.traceId,
          message: `${ctx.avatar.name} 在群組「${conv.title ?? ''}」開了話題`,
          data: { messages: output.messages },
        });
        await this.bumpProactiveCount(avatarId);
        await this.applyState(ctx, output);
        await this.deps.onReplied?.(avatarId, conversationId);
        return sent ? 'sent' : 'skipped';
      } finally {
        await this.deps.lock.release(key, token);
      }
    });
  }

  /** 重試都失敗後，在對話裡留一則系統訊息，玩家可以按「重試」 */
  async reportFailure(conversationId: string, err: unknown): Promise<void> {
    const ctx = await this.loadContext(conversationId);
    const who = ctx?.avatar.name ?? 'avatar';
    await postMessage(this.deps.db, this.deps.events, {
      conversationId,
      senderType: 'system',
      content: `${who} 的回覆失敗：${(err as Error).message ?? String(err)}`,
      meta: { systemKind: 'error' },
    });
  }

  private async generateAndSend(
    ctx: Ctx,
    snapshot: Date,
    setTyping: (avatarId: string, typing: boolean) => Promise<void>,
    situation: PromptSituation,
  ): Promise<Outcome> {
    const avatarId = ctx.avatar.id;
    await this.sleep(readPauseMs(this.random));
    if (await this.hasNewerUserMessage(ctx.conversationId, snapshot)) return { kind: 'restart' };

    await setTyping(avatarId, true);
    const output = await this.generate(ctx, situation);
    if (await this.hasNewerUserMessage(ctx.conversationId, snapshot)) {
      await setTyping(avatarId, false);
      return { kind: 'restart' };
    }

    for (const [i, text] of output.messages.entries()) {
      if (i > 0) await setTyping(avatarId, true);
      await this.sleep(typingMs(text, this.random, ctx.avatar.persona.speech?.typingSpeed));
      if (await this.hasNewerUserMessage(ctx.conversationId, snapshot)) {
        await setTyping(avatarId, false);
        return i === 0 ? { kind: 'restart' } : { kind: 'interrupted', output };
      }
      await postMessage(this.deps.db, this.deps.events, {
        conversationId: ctx.conversationId,
        senderType: 'avatar',
        senderAvatarId: avatarId,
        content: text,
        meta: {
          ...(output.traceId ? { traceId: output.traceId } : {}),
          ...(i === 0 && output.innerThought ? { innerThought: output.innerThought } : {}),
        },
      });
      await setTyping(avatarId, false);
      if (i < output.messages.length - 1) await this.sleep(betweenMessagesMs(this.random));
    }
    if (output.photo) await this.sendPhoto(ctx, output);
    else if (!output.messages.length) await setTyping(avatarId, false);
    return { kind: 'sent', output };
  }

  /**
   * avatar 想傳照片：生成後當成一則圖片訊息送出（生成期間顯示「輸入中」）。
   * 不能傳（沒設定圖片模型、今天的張數用完）就略過；生成失敗留一則提示。
   */
  private async sendPhoto(ctx: Ctx, output: ReplyOutput, opts: { proactive?: boolean } = {}): Promise<boolean> {
    const { db, events } = this.deps;
    const settings = await loadSettings(db);
    const remaining = await photosRemaining(db, settings, ctx.avatar.id, { mediaDir: this.deps.mediaDir, now: this.now() });
    if (!remaining) {
      await logEvent({
        category: 'reply',
        type: 'photo.skipped',
        avatarId: ctx.avatar.id,
        message: `${ctx.avatar.name} 想傳照片，但${remaining === 0 ? '今天的張數用完了' : '目前不能傳照片（沒有設定圖片模型、關掉了或超過用量上限）'}`,
        data: { description: output.photo },
      });
      return false;
    }
    const typing = (on: boolean) => events.publish({ type: 'typing', conversationId: ctx.conversationId, avatarId: ctx.avatar.id, typing: on });
    await typing(true);
    try {
      const image = await takePhoto({ ...this.deps, mediaDir: this.deps.mediaDir! }, settings, ctx.avatar, output.photo!);
      await postMessage(db, events, {
        conversationId: ctx.conversationId,
        senderType: 'avatar',
        senderAvatarId: ctx.avatar.id,
        content: '',
        meta: { image, ...(output.traceId ? { traceId: output.traceId } : {}), ...(opts.proactive ? { proactive: true } : {}) },
      });
      await logEvent({
        category: 'reply',
        type: 'photo.sent',
        avatarId: ctx.avatar.id,
        traceId: output.traceId,
        message: `${ctx.avatar.name} 傳了一張照片：${output.photo}`,
      });
      return true;
    } catch (err) {
      const message = (err as Error).message;
      await logEvent({ category: 'reply', type: 'photo.failed', level: 'warn', avatarId: ctx.avatar.id, message: `${ctx.avatar.name} 的照片生成失敗：${message}` });
      await this.noticeOnce(ctx.conversationId, `${ctx.avatar.name} 的照片沒傳出去（${message.slice(0, 120)}）`);
      return false;
    } finally {
      await typing(false);
    }
  }

  /** 回覆送出後更新心情與關係 */
  private async applyState(ctx: Ctx, output: ReplyOutput): Promise<void> {
    const db = this.deps.db;
    if (output.mood) await setMood(db, ctx.avatar.id, output.mood);
    const warmUp = ctx.avatar.persona.romance?.warmUpSpeed ?? 'medium';
    const { before, after } = await applyInteraction(
      db,
      ctx.avatar.id,
      { affinity: output.affinityDelta, trust: output.trustDelta, event: output.event?.type, note: output.event?.note },
      warmUp,
    );
    // 群組：對其他成員的好感
    const others: string[] = [];
    if (Object.keys(output.othersAffinity).length) {
      const names = await this.memberNames(ctx.conversationId);
      for (const [name, d] of Object.entries(output.othersAffinity)) {
        const id = [...names.entries()].find(([, n]) => n === name)?.[0];
        if (!id || id === ctx.avatar.id) continue;
        const r = await applyInteraction(db, ctx.avatar.id, { affinity: d }, warmUp, `avatar:${id}`);
        others.push(`對${name}的好感 ${r.before.affinity} → ${r.after.affinity}`);
      }
    }
    // 群組：一起聊天的成員（還不熟的）自然變熟一點，每一對每天有上限
    if (ctx.type === 'group') {
      const { timezone } = await loadSettings(db);
      const day = localClock(this.now(), timezone).date;
      const names = await this.memberNames(ctx.conversationId);
      for (const id of await this.recentSpeakers(ctx.conversationId, ctx.avatar.id)) {
        if (!names.has(id)) continue;
        // 雙向：先說話的人也會因為後來接話的人而變熟
        const r = await growFamiliarity(db, ctx.avatar.id, id, day, warmUp);
        if (r && r.before.stage !== r.after.stage) {
          others.push(`和${names.get(id)}熟了起來：${STAGE_LABELS[r.before.stage]} → ${STAGE_LABELS[r.after.stage]}`);
        }
        const back = await growFamiliarity(db, id, ctx.avatar.id, day);
        if (back && back.before.stage !== back.after.stage) {
          await this.deps.events.publish({ type: 'avatar.state.changed', avatarId: id });
        }
      }
    }
    const changed =
      output.mood || others.length || before.affinity !== after.affinity || before.trust !== after.trust || before.stage !== after.stage;
    if (changed) {
      await this.deps.events.publish({ type: 'avatar.state.changed', avatarId: ctx.avatar.id });
      const parts = [
        output.mood ? `心情：${output.mood.label}` : '',
        before.affinity !== after.affinity ? `好感 ${before.affinity} → ${after.affinity}` : '',
        before.trust !== after.trust ? `信任 ${before.trust} → ${after.trust}` : '',
        before.stage !== after.stage ? `關係 ${before.stage} → ${after.stage}` : '',
        output.event ? `事件：${output.event.type}` : '',
        ...others,
      ].filter(Boolean);
      await logEvent({
        category: 'state',
        type: before.stage !== after.stage ? 'state.stage' : 'state.updated',
        avatarId: ctx.avatar.id,
        traceId: output.traceId,
        message: `${ctx.avatar.name}：${parts.join('、')}`,
        data: {
          mood: output.mood,
          requested: { affinity: output.affinityDelta, trust: output.trustDelta, event: output.event },
          before,
          after,
          warmUp,
        },
      });
    }
  }

  /** 組出 prompt（不呼叫 LLM）；回覆、主動發話與監控頁的預覽共用 */
  private async buildPrompt(ctx: Ctx, situation: PromptSituation, opts: { preview?: boolean } = {}) {
    const settings: AppSettings = await loadSettings(this.deps.db);
    const db = this.deps.db;
    const history = await this.loadHistory(ctx.conversationId);
    const profile = await loadProfile(db);
    const now = this.now();
    const links = (await loadLinks(db, [ctx.avatar.id])).get(ctx.avatar.id) ?? [];
    const acquaintances = await linkedAvatars(db, links);
    // 在群組裡認識的（沒有設成相關角色、已經不是陌生人的）
    const met = await db
      .select({ id: avatars.id, name: avatars.name, bio: avatars.bio, persona: avatars.persona })
      .from(relationships)
      .innerJoin(avatars, sql`${relationships.target} = 'avatar:' || ${avatars.id}::text`)
      .where(and(eq(relationships.avatarId, ctx.avatar.id), ne(relationships.stage, 'stranger')));
    for (const m of met) {
      if (m.id === ctx.avatar.id || acquaintances.some((a) => a.id === m.id)) continue;
      acquaintances.push({ ...m, relation: '在群組裡認識的', stage: 'acquaintance' });
    }
    const otherStages = acquaintances.length
      ? await db
          .select({ target: relationships.target, stage: relationships.stage })
          .from(relationships)
          .where(and(eq(relationships.avatarId, ctx.avatar.id), inArray(relationships.target, acquaintances.map((a) => `avatar:${a.id}`))))
      : [];
    const group = ctx.type === 'group' ? await this.groupInfo(ctx, situation, profile.preferences?.nickname, links) : null;
    const embedder = await embedderFromSettings(db, this.deps.box, settings, this.deps.fetchFn).catch(() => null);
    const [relationship, mood, impression] = await Promise.all([
      getRelationship(db, ctx.avatar.id),
      getMood(db, ctx.avatar.id, now),
      latestImpression(db, ctx.avatar.id),
    ]);
    // 用最近幾則訊息當查詢，找出相關的記憶
    const query = history
      .slice(-4)
      .map((m) => m.content)
      .join('\n');
    const memories = await retrieveMemories(db, embedder, { avatarId: ctx.avatar.id, query, now, touch: !opts.preview });
    if (!opts.preview) await logEvent({
      category: 'memory',
      type: 'memory.retrieve',
      level: 'debug',
      avatarId: ctx.avatar.id,
      message: `${ctx.avatar.name}：想起 ${memories.length} 件記憶${embedder ? '' : '（沒有嵌入模型，用關鍵字比對）'}`,
      data: { query, memories: memories.map((m) => ({ content: m.content, score: Math.round(m.score * 1000) / 1000 })) },
    });
    const lifeLog = await getLifeLog(db, ctx.avatar.id, localClock(now, settings.timezone).date);
    const canSee = await profileVision(db, ctx.avatar.llm?.profileId);
    const images = await prepareImages(this.deps, settings, history, { selfId: ctx.avatar.id, canSee, preview: opts.preview });
    const photosLeft = await photosRemaining(db, settings, ctx.avatar.id, { mediaDir: this.deps.mediaDir, now });
    const { system, messages: built } = buildReplyPrompt({
      avatar: { name: ctx.avatar.name, bio: ctx.avatar.bio, persona: ctx.avatar.persona },
      user: profile.preferences
        ? { preferences: profile.preferences, summary: profile.summary, results: profile.results }
        : null,
      state: {
        relationship: { stage: relationship.stage, affinity: relationship.affinity, trust: relationship.trust },
        mood,
        memories,
        impression: impression?.content ?? null,
      },
      situation,
      lifeLog,
      group,
      acquaintances: acquaintances.map((a) => ({
        name: a.name,
        relation: a.relation,
        bio: a.bio,
        occupation: a.persona.basic?.occupation,
        traits: a.persona.personality?.traits,
        stage: otherStages.find((r) => r.target === `avatar:${a.id}`)?.stage,
      })),
      settings,
      history,
      images,
      photos: photosLeft === null ? null : { remaining: photosLeft, appears: avatarPhoto(ctx.avatar).appears, proxy: avatarPhoto(ctx.avatar).proxy },
      now,
    });
    // 最後一則不是別人說的話時（主動發話、群組裡自己剛說過），補一個提示回合（Anthropic、Gemini 要求最後是 user）
    const last = history.at(-1);
    const gap = last ? `距離上一則訊息過了 ${formatGap(now.getTime() - last.createdAt.getTime())}。` : '你們還沒聊過天。';
    const nudge =
      situation.mode === 'proactive'
        ? `（系統：${gap}現在由你主動${group ? '在群組裡開個話題' : '傳訊息給對方'}。）`
        : built.at(-1)?.role === 'assistant'
          ? '（系統：輪到你說話。）'
          : null;
    const chat = nudge ? [...built, { role: 'user' as const, content: nudge }] : built;
    const allowEmpty = situation.mode === 'proactive' || !!group;
    return {
      system,
      chat,
      settings,
      allowEmpty,
      notes: {
        situation,
        relationship: { stage: relationship.stage, affinity: relationship.affinity, trust: relationship.trust },
        mood,
        memories: memories.length,
        embedder: embedder?.model ?? null,
        lifeLog: lifeLog?.length ?? 0,
        historyMessages: history.length,
        images: { canSee, attached: images.size, photosLeft },
        disclosure: profile.preferences ? relationship.stage : 'no-profile',
        group: group ? { title: group.title, members: group.members.map((m) => m.name), mentioned: group.mentioned } : null,
      },
    };
  }

  /** 群組的成員、與每個成員的關係 */
  private async groupInfo(ctx: Ctx, situation: PromptSituation, nickname?: string, links: AvatarLink[] = []): Promise<PromptGroup> {
    const db = this.deps.db;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
    const rows = await db
      .select({ avatar: avatars })
      .from(conversationMembers)
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      .where(eq(conversationMembers.conversationId, ctx.conversationId));
    const members = [];
    for (const { avatar } of rows) {
      if (avatar.id === ctx.avatar.id) continue;
      const r = await getRelationship(db, ctx.avatar.id, `avatar:${avatar.id}`, 'stranger');
      members.push({
        id: avatar.id,
        name: avatar.name,
        bio: avatar.bio,
        relationship: { stage: r.stage, affinity: r.affinity, trust: r.trust },
        relation: links.find((l) => l.avatarId === avatar.id)?.relation,
      });
    }
    return {
      conversationId: ctx.conversationId,
      title: conv?.title ?? '群組',
      selfId: ctx.avatar.id,
      members,
      userName: nickname || '玩家',
      discretion: ctx.avatar.persona.principles?.discretion ?? 60,
      mentioned: situation.mentioned,
      before: situation.before,
    };
  }

  /** 剛剛一起在群組裡說話的其他成員：最近 15 則裡、和最新一則相隔兩小時內的 */
  private async recentSpeakers(conversationId: string, selfId: string): Promise<string[]> {
    const rows = await this.deps.db
      .select({ who: messages.senderAvatarId, at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.senderType, ['user', 'avatar'])))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(15);
    const latest = rows[0]?.at.getTime() ?? 0;
    const ids = rows.filter((r) => latest - r.at.getTime() < 2 * 3_600_000).map((r) => r.who);
    return [...new Set(ids.filter((w): w is string => !!w && w !== selfId))];
  }

  private async memberNames(conversationId: string): Promise<Map<string, string>> {
    const rows = await this.deps.db
      .select({ id: avatars.id, name: avatars.name })
      .from(conversationMembers)
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      .where(eq(conversationMembers.conversationId, conversationId));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** 監控頁：如果現在回覆（或主動發話），會送出什麼 */
  async previewPrompt(conversationId: string, mode: 'reply' | 'proactive', avatarId?: string) {
    const ctx = await this.loadContext(conversationId, avatarId);
    if (!ctx) return null;
    const now = this.now();
    const situation: PromptSituation =
      mode === 'proactive'
        ? { mode: 'proactive' }
        : ctx.type === 'group'
          ? { mode: 'group' }
          : { mode: 'reply', reason: ctx.replyReason ?? 'normal', waitedMs: await this.waitedMs(ctx, now) };
    const { system, chat, notes } = await this.buildPrompt(ctx, situation, { preview: true });
    return {
      system,
      messages: chat.map((m) => ({ role: m.role, content: loggedContent(m.content) })),
      notes: { ...notes, avatar: ctx.avatar.name, llm: ctx.avatar.llm },
    };
  }

  private async generate(ctx: Ctx, situation: PromptSituation): Promise<ReplyOutput> {
    const { system, chat, settings, allowEmpty } = await this.buildPrompt(ctx, situation);
    const call = (extra: typeof chat = []) =>
      callWithBinding(
        this.deps,
        ctx.avatar.llm!,
        { system, messages: [...chat, ...extra], json: true, relaxedSafety: settings.adultContent },
        { purpose: 'reply', avatarId: ctx.avatar.id },
      );

    const first = await call();
    const parsed = parseReplyOutput(first.text, { allowEmpty });
    if (parsed) {
      await attachParsed(first.traceId, parsed);
      return { ...parsed, traceId: first.traceId };
    }
    await logEvent({
      category: 'llm',
      type: 'llm.format',
      level: 'warn',
      avatarId: ctx.avatar.id,
      traceId: first.traceId,
      message: `${ctx.avatar.name}：模型的輸出不是指定的 JSON，提醒後重試`,
    });
    // 格式不對：提醒一次再試
    const second = await call([
      { role: 'assistant', content: first.text },
      { role: 'user', content: FORMAT_REMINDER },
    ]);
    const output =
      parseReplyOutput(second.text, { allowEmpty }) ?? plainTextFallback(first.text) ?? plainTextFallback(second.text);
    if (!output) throw new Error(`模型的輸出無法解析：${first.text.slice(0, 120)}`);
    await attachParsed(second.traceId, output);
    return { ...output, traceId: second.traceId };
  }

  /** 一對一：唯一的成員；群組：指定的成員 */
  private async loadContext(conversationId: string, avatarId?: string): Promise<Ctx | null> {
    const [row] = await this.deps.db
      .select({ avatar: avatars, member: conversationMembers, type: conversations.type })
      .from(conversations)
      .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      .where(
        and(
          eq(conversations.id, conversationId),
          avatarId ? eq(conversationMembers.avatarId, avatarId) : eq(conversations.type, 'dm'),
        ),
      );
    return row
      ? {
          conversationId,
          type: row.type,
          avatar: row.avatar,
          handledUpTo: row.member.handledUpTo,
          seenUpTo: row.member.seenUpTo,
          replyDueAt: row.member.replyDueAt,
          replyReason: row.member.replyReason,
        }
      : null;
  }

  private async latestUserMessageAt(conversationId: string): Promise<Date | null> {
    const [row] = await this.deps.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'user')))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  }

  private async hasNewerUserMessage(conversationId: string, snapshot: Date): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'user'), gt(messages.createdAt, snapshot)),
      )
      .limit(1);
    return !!row;
  }

  private async loadHistory(conversationId: string): Promise<LoadedHistory> {
    const rows = await this.deps.db
      .select({
        id: messages.id,
        senderType: messages.senderType,
        senderAvatarId: messages.senderAvatarId,
        content: messages.content,
        createdAt: messages.createdAt,
        meta: messages.meta,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.senderType, ['user', 'avatar'])))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(HISTORY_LOAD);
    return rows.reverse().map(({ meta, ...m }) => ({
      ...(m as HistoryMessage & { id: string }),
      image: meta.image ? { caption: meta.image.caption ?? null, description: meta.image.description ?? null } : null,
      imageFile: meta.image,
    }));
  }

  private async markSeen(ctx: Ctx, snapshot: Date): Promise<void> {
    await this.deps.db
      .update(conversationMembers)
      .set({ seenUpTo: snapshot })
      .where(and(eq(conversationMembers.conversationId, ctx.conversationId), eq(conversationMembers.avatarId, ctx.avatar.id)));
    await this.deps.events.publish({
      type: 'conversation.seen',
      conversationId: ctx.conversationId,
      avatarId: ctx.avatar.id,
      seenUpTo: snapshot.toISOString(),
    });
  }

  private async markHandled(ctx: Ctx, snapshot: Date): Promise<void> {
    await this.deps.db
      .update(conversationMembers)
      // 回完了，下一則訊息重新計算什麼時候看到
      .set({ handledUpTo: snapshot, replyDueAt: null, replyReason: null })
      .where(and(eq(conversationMembers.conversationId, ctx.conversationId), eq(conversationMembers.avatarId, ctx.avatar.id)));
  }

  /** 同樣的提示已經是最後一則系統訊息時就不再重複 */
  /**
   * 超過每日上限時留一則提示（同樣的提示不重複留）並回傳 true。
   * withRetry：一對一回覆用「錯誤」樣式，玩家調高上限後可以按「重試」。
   */
  private async overQuota(conversationId: string, avatar: { id: string; name: string }, withRetry: boolean): Promise<boolean> {
    const q = await quotaStatus(this.deps.db, avatar.id, this.now());
    if (!q.over) return false;
    if (withRetry) await this.quotaNotice(conversationId, avatar.name, q.over);
    else {
      await logEvent({
        category: 'usage',
        type: 'usage.quota',
        level: 'warn',
        avatarId: avatar.id,
        message: `${avatar.name}：${q.over === 'global' ? '今天的總用量' : '它今天的用量'}已達上限，不主動發話`,
      });
    }
    return true;
  }

  private async quotaNotice(conversationId: string, name: string | null, scope: 'global' | 'avatar') {
    const content =
      scope === 'global'
        ? `今天的總用量已達上限，avatar 暫時不會回覆，明天會自動恢復。要繼續的話到「設定 → 一般 → 費用」調高上限，再按重試。`
        : `${name} 今天的用量已達上限，明天才會回覆。要繼續的話到它的設定頁「大腦」調高上限，再按重試。`;
    await logEvent({ category: 'usage', type: 'usage.quota', level: 'warn', message: content });
    await this.noticeOnce(conversationId, content, 'error');
  }

  private async noticeOnce(conversationId: string, content: string, kind: 'notice' | 'error' = 'notice'): Promise<void> {
    const [last] = await this.deps.db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), ne(messages.senderType, 'user')))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(1);
    if (last?.content === content) return;
    await postMessage(this.deps.db, this.deps.events, {
      conversationId,
      senderType: 'system',
      content,
      meta: { systemKind: kind },
    });
  }
}
