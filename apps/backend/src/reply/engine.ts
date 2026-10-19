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
import { localClock, type AppSettings } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { avatars, avatarState, conversationMembers, conversations, messages } from '../db/schema.ts';
import type { EventPublisher } from '../events/bus.ts';
import type { FetchFn } from '../llm/index.ts';
import { getLifeLog } from '../life/lifeLog.ts';
import type { Lock } from '../lock.ts';
import { embedderFromSettings } from '../memory/embedder.ts';
import { latestImpression, retrieveMemories } from '../memory/store.ts';
import { loadProfile } from '../profile/service.ts';
import { applyInteraction, getMood, getRelationship, setMood } from '../relationship/service.ts';
import { callWithBinding } from '../services/llmCall.ts';
import { postMessage } from '../services/messages.ts';
import { loadSettings } from '../services/settings.ts';
import { parseReplyOutput, plainTextFallback, type ReplyOutput } from './output.ts';
import { buildReplyPrompt, formatGap, type HistoryMessage, type PromptSituation } from './prompt.ts';
import { betweenMessagesMs, readPauseMs, typingMs, type Random } from './timing.ts';

export interface ReplyEngineDeps {
  db: Db;
  box: SecretBox;
  events: EventPublisher;
  lock: Lock;
  /** 回覆完成後呼叫（排程記憶萃取） */
  onReplied?: (avatarId: string, conversationId: string) => Promise<void>;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  random?: Random;
  now?: () => Date;
}

type Outcome = { kind: 'restart' } | { kind: 'sent' | 'interrupted'; output: ReplyOutput };

interface Ctx {
  conversationId: string;
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
        if (round === 0 && !opts.force && ctx.replyDueAt && now.getTime() < ctx.replyDueAt.getTime() - 1000) return 'early';

        if (!ctx.avatar.llm) {
          await this.noticeOnce(
            ctx,
            `${ctx.avatar.name} 還沒有設定大腦（LLM）。到 avatar 設定頁綁定一個 LLM 設定檔後，就能開始回覆。`,
          );
          await this.markHandled(ctx, snapshot);
          return 'done';
        }

        // 第一輪才有「怎麼看到訊息」的情境；之後是正在聊天中
        const situation: PromptSituation =
          round === 0
            ? { mode: 'reply', reason: ctx.replyReason ?? 'normal', waitedMs: await this.waitedMs(ctx, now) }
            : { mode: 'reply', reason: 'normal' };
        await this.markSeen(ctx, snapshot);
        const outcome = await this.generateAndSend(ctx, snapshot, setTyping, situation);
        if (outcome.kind === 'restart') continue;
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

      const startedAt = this.now();
      const output = await this.generate(ctx, { mode: 'proactive' });
      if (!output.messages.length) return 'skipped';
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
          meta: { proactive: true, ...(i === 0 && output.innerThought ? { innerThought: output.innerThought } : {}) },
        });
        sent++;
        await setTyping(ctx.avatar.id, false);
        if (i < output.messages.length - 1) await this.sleep(betweenMessagesMs(this.random));
      }
      if (!sent) return 'skipped';
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
        meta: i === 0 && output.innerThought ? { innerThought: output.innerThought } : {},
      });
      await setTyping(avatarId, false);
      if (i < output.messages.length - 1) await this.sleep(betweenMessagesMs(this.random));
    }
    return { kind: 'sent', output };
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
    const changed = output.mood || before.affinity !== after.affinity || before.trust !== after.trust || before.stage !== after.stage;
    if (changed) await this.deps.events.publish({ type: 'avatar.state.changed', avatarId: ctx.avatar.id });
  }

  private async generate(ctx: Ctx, situation: PromptSituation): Promise<ReplyOutput> {
    const settings: AppSettings = await loadSettings(this.deps.db);
    const db = this.deps.db;
    const history = await this.loadHistory(ctx.conversationId);
    const profile = await loadProfile(db);
    const now = this.now();
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
    const memories = await retrieveMemories(db, embedder, { avatarId: ctx.avatar.id, query, now });
    const lifeLog = await getLifeLog(db, ctx.avatar.id, localClock(now, settings.timezone).date);
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
      settings,
      history,
      now,
    });
    // 主動傳訊息時，最後一則不是玩家說的話；補一個提示回合（Anthropic、Gemini 要求最後是 user）
    const last = history.at(-1);
    const chat =
      situation.mode === 'proactive'
        ? [
            ...built,
            {
              role: 'user' as const,
              content: `（系統：${last ? `距離上一則訊息過了 ${formatGap(now.getTime() - last.createdAt.getTime())}。` : '你們還沒聊過天。'}現在由你主動傳訊息給對方。）`,
            },
          ]
        : built;
    const allowEmpty = situation.mode === 'proactive';
    const call = (extra: typeof chat = []) =>
      callWithBinding(
        this.deps,
        ctx.avatar.llm!,
        { system, messages: [...chat, ...extra], json: true, relaxedSafety: settings.adultContent },
        { purpose: 'reply', avatarId: ctx.avatar.id },
      );

    const first = await call();
    const parsed = parseReplyOutput(first.text, { allowEmpty });
    if (parsed) return parsed;
    // 格式不對：提醒一次再試
    const second = await call([
      { role: 'assistant', content: first.text },
      { role: 'user', content: FORMAT_REMINDER },
    ]);
    const output =
      parseReplyOutput(second.text, { allowEmpty }) ?? plainTextFallback(first.text) ?? plainTextFallback(second.text);
    if (!output) throw new Error(`模型的輸出無法解析：${first.text.slice(0, 120)}`);
    return output;
  }

  private async loadContext(conversationId: string): Promise<Ctx | null> {
    const [row] = await this.deps.db
      .select({ avatar: avatars, member: conversationMembers })
      .from(conversations)
      .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      // 群組的回覆在第 7 階段
      .where(and(eq(conversations.id, conversationId), eq(conversations.type, 'dm')));
    return row
      ? {
          conversationId,
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

  private async loadHistory(conversationId: string): Promise<HistoryMessage[]> {
    const rows = await this.deps.db
      .select({ senderType: messages.senderType, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.senderType, ['user', 'avatar'])))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(HISTORY_LOAD);
    return rows.reverse() as HistoryMessage[];
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
  private async noticeOnce(ctx: Ctx, content: string): Promise<void> {
    const [last] = await this.deps.db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, ctx.conversationId), ne(messages.senderType, 'user')))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(1);
    if (last?.content === content) return;
    await postMessage(this.deps.db, this.deps.events, {
      conversationId: ctx.conversationId,
      senderType: 'system',
      content,
      meta: { systemKind: 'notice' },
    });
  }
}
