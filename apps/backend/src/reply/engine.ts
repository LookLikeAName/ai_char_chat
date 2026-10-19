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
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { AppSettings } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { avatars, conversationMembers, conversations, messages } from '../db/schema.ts';
import type { EventPublisher } from '../events/bus.ts';
import type { FetchFn } from '../llm/index.ts';
import type { Lock } from '../lock.ts';
import { callWithBinding } from '../services/llmCall.ts';
import { postMessage } from '../services/messages.ts';
import { loadSettings } from '../services/settings.ts';
import { parseReplyOutput, plainTextFallback, type ReplyOutput } from './output.ts';
import { buildReplyPrompt, type HistoryMessage } from './prompt.ts';
import { betweenMessagesMs, readPauseMs, typingMs, type Random } from './timing.ts';

export interface ReplyEngineDeps {
  db: Db;
  box: SecretBox;
  events: EventPublisher;
  lock: Lock;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  random?: Random;
  now?: () => Date;
}

type Outcome = 'sent' | 'interrupted' | 'restart';

interface Ctx {
  conversationId: string;
  avatar: typeof avatars.$inferSelect;
  handledUpTo: Date | null;
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

  /** 'busy'：另一個流程正在處理這個對話，呼叫端應該稍後再試 */
  async handle(conversationId: string): Promise<'busy' | 'done'> {
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

        if (!ctx.avatar.llm) {
          await this.noticeOnce(
            ctx,
            `${ctx.avatar.name} 還沒有設定大腦（LLM）。到 avatar 設定頁綁定一個 LLM 設定檔後，就能開始回覆。`,
          );
          await this.markHandled(ctx, snapshot);
          return 'done';
        }

        await this.markSeen(ctx, snapshot);
        const outcome = await this.generateAndSend(ctx, snapshot, setTyping);
        if (outcome === 'restart') continue;
        await this.markHandled(ctx, snapshot);
      }
      return 'done';
    } finally {
      if (typingAvatar) await setTyping(typingAvatar, false).catch(() => {});
      await this.deps.lock.release(key, token);
    }
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
  ): Promise<Outcome> {
    const avatarId = ctx.avatar.id;
    await this.sleep(readPauseMs(this.random));
    if (await this.hasNewerUserMessage(ctx.conversationId, snapshot)) return 'restart';

    await setTyping(avatarId, true);
    const output = await this.generate(ctx);
    if (await this.hasNewerUserMessage(ctx.conversationId, snapshot)) {
      await setTyping(avatarId, false);
      return 'restart';
    }

    for (const [i, text] of output.messages.entries()) {
      if (i > 0) await setTyping(avatarId, true);
      await this.sleep(typingMs(text, this.random, ctx.avatar.persona.speech?.typingSpeed));
      if (await this.hasNewerUserMessage(ctx.conversationId, snapshot)) {
        await setTyping(avatarId, false);
        return i === 0 ? 'restart' : 'interrupted';
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
    return 'sent';
  }

  private async generate(ctx: Ctx): Promise<ReplyOutput> {
    const settings: AppSettings = await loadSettings(this.deps.db);
    const history = await this.loadHistory(ctx.conversationId);
    const { system, messages: chat } = buildReplyPrompt({
      avatar: { name: ctx.avatar.name, bio: ctx.avatar.bio, persona: ctx.avatar.persona },
      settings,
      history,
      now: this.now(),
    });
    const call = (extra: typeof chat = []) =>
      callWithBinding(
        this.deps,
        ctx.avatar.llm!,
        { system, messages: [...chat, ...extra], json: true, relaxedSafety: settings.adultContent },
        { purpose: 'reply', avatarId: ctx.avatar.id },
      );

    const first = await call();
    const parsed = parseReplyOutput(first.text);
    if (parsed) return parsed;
    // 格式不對：提醒一次再試
    const second = await call([
      { role: 'assistant', content: first.text },
      { role: 'user', content: FORMAT_REMINDER },
    ]);
    const output = parseReplyOutput(second.text) ?? plainTextFallback(first.text) ?? plainTextFallback(second.text);
    if (!output) throw new Error(`模型的輸出無法解析：${first.text.slice(0, 120)}`);
    return output;
  }

  private async loadContext(conversationId: string): Promise<Ctx | null> {
    const [row] = await this.deps.db
      .select({ avatar: avatars, handledUpTo: conversationMembers.handledUpTo })
      .from(conversations)
      .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      // 群組的回覆在第 7 階段
      .where(and(eq(conversations.id, conversationId), eq(conversations.type, 'dm')));
    return row ? { conversationId, avatar: row.avatar, handledUpTo: row.handledUpTo } : null;
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
      .set({ handledUpTo: snapshot })
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
