import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type {
  AllAnswers,
  EventCategory,
  EventLevel,
  TraceDto,
  LifeLogEvent,
  LlmBinding,
  LlmParams,
  LlmPricing,
  Mood,
  PersonaDraft,
  Preferences,
  ProviderType,
  RelationshipEventRecord,
  SeenReason,
  Stage,
} from '@acc/shared';

export interface MessageMeta {
  /** avatar 這一輪回覆的內心想法（只存在第一則） */
  innerThought?: string;
  /** 系統訊息的種類 */
  systemKind?: 'error' | 'notice';
  /** avatar 主動傳的訊息（不是回覆） */
  proactive?: boolean;
  /** 產生這則訊息的 LLM 呼叫 */
  traceId?: string;
}

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** 只有一列（id = 1），內容依 appSettingsSchema 驗證 */
export const settings = pgTable('settings', {
  id: smallint('id').primaryKey(),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const llmProfiles = pgTable('llm_profiles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  provider: text('provider').$type<ProviderType>().notNull(),
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  apiKeyEnc: text('api_key_enc'),
  apiKeyHint: text('api_key_hint'),
  defaults: jsonb('defaults').$type<LlmParams>().notNull().default({}),
  pricing: jsonb('pricing').$type<LlmPricing | null>(),
  ...timestamps,
});

export const avatars = pgTable('avatars', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  bio: text('bio').notNull().default(''),
  imagePath: text('image_path'),
  /** 完整人格設定（PersonaDraft）：全空或全部填滿 */
  persona: jsonb('persona').$type<PersonaDraft>().notNull().default({}),
  /** 玩家鎖定的人格欄位 */
  personaLocks: jsonb('persona_locks').$type<string[]>().notNull().default([]),
  llm: jsonb('llm').$type<LlmBinding | null>(),
  /** 每天最多用多少 tokens（0 = 不限） */
  dailyTokenLimit: integer('daily_token_limit').notNull().default(0),
  ...timestamps,
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  type: text('type').$type<'dm' | 'group'>().notNull(),
  title: text('title'),
  imagePath: text('image_path'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  /** 玩家最後看過這個對話的時間，用來算未讀數 */
  userReadAt: timestamp('user_read_at', { withTimezone: true, precision: 3 }),
  /** 群組：這一輪什麼時候開始（玩家發話後等幾秒；玩家還在打字就延後） */
  turnDueAt: timestamp('turn_due_at', { withTimezone: true, precision: 3 }),
  /** 群組：玩家最後一次在輸入框打字的時間 */
  userTypingAt: timestamp('user_typing_at', { withTimezone: true, precision: 3 }),
  /** 群組：已經處理（輪過）的玩家訊息到這個時間點 */
  handledUpTo: timestamp('handled_up_to', { withTimezone: true, precision: 3 }),
  ...timestamps,
});

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** avatar 已經「看到」的玩家訊息（含）到這個時間點，用來顯示已讀 */
    seenUpTo: timestamp('seen_up_to', { withTimezone: true, precision: 3 }),
    /** avatar 已經回應過的玩家訊息（含）到這個時間點；之後的玩家訊息就是「還沒回」 */
    handledUpTo: timestamp('handled_up_to', { withTimezone: true, precision: 3 }),
    /** 記憶萃取處理到哪個時間點（含） */
    memoryUpTo: timestamp('memory_up_to', { withTimezone: true, precision: 3 }),
    /** 預計什麼時候「看到」還沒讀的訊息；新訊息只會讓它提前 */
    replyDueAt: timestamp('reply_due_at', { withTimezone: true, precision: 3 }),
    /** 看到的原因（normal、peek、late、interrupted、woken），回覆時告訴 avatar 當下的情境 */
    replyReason: text('reply_reason').$type<SeenReason>(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.avatarId] }), index('conversation_members_avatar_idx').on(t.avatarId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** 寫入順序；時間戳相同（同一毫秒）時用來排序 */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').$type<'user' | 'avatar' | 'system'>().notNull(),
    senderAvatarId: uuid('sender_avatar_id').references(() => avatars.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    meta: jsonb('meta').$type<MessageMeta>().notNull().default({}),
    // 毫秒精度：和 JS 的 Date 一致，「已讀到／已回覆到哪一則」才能直接比較
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_created_idx').on(t.conversationId, t.createdAt, t.seq)],
);

/** 每次 LLM 呼叫的用量，供用量統計與每日上限 */
export const usageLog = pgTable(
  'usage_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    purpose: text('purpose').notNull(),
    avatarId: uuid('avatar_id').references(() => avatars.id, { onDelete: 'set null' }),
    profileId: uuid('profile_id').references(() => llmProfiles.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    /** 依當時設定檔的價格估算 */
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    ok: boolean('ok').notNull(),
    error: text('error'),
  },
  (t) => [index('usage_log_created_idx').on(t.createdAt), index('usage_log_avatar_created_idx').on(t.avatarId, t.createdAt)],
);

/** 玩家的 profile（單人使用，只有一列 id = 1） */
export const userProfile = pgTable('user_profile', {
  id: smallint('id').primaryKey(),
  /** 偏好問卷；還沒填過時為 null */
  preferences: jsonb('preferences').$type<Preferences | null>(),
  answers: jsonb('answers').$type<AllAnswers>().notNull().default({}),
  summary: text('summary').notNull().default(''),
  summaryAt: timestamp('summary_at', { withTimezone: true, precision: 3 }),
  /** 作答或偏好最後變更的時間，用來判斷摘要是否過期 */
  inputsUpdatedAt: timestamp('inputs_updated_at', { withTimezone: true, precision: 3 }),
});

export const EMBEDDING_DIMS = 768;

/** avatar 各自的長期記憶 */
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** event：發生過的事；impression：對某人的整體印象（反思產生） */
    kind: text('kind').$type<'event' | 'impression'>().notNull(),
    content: text('content').notNull(),
    /** 1～10 */
    importance: integer('importance').notNull().default(5),
    /** 關於誰：user、avatar:<id>、self */
    about: text('about').notNull().default('user'),
    /** 從哪個對話得知；可見性：private（一對一）、group:<id>、public */
    sourceConversationId: uuid('source_conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    visibility: text('visibility').notNull().default('private'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMS }),
    /** 產生向量的模型；換模型後舊向量不能比較，要重新嵌入 */
    embeddingModel: text('embedding_model'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('memories_avatar_idx').on(t.avatarId, t.kind, t.createdAt),
    index('memories_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** avatar 對某個對象的關係（目前只有玩家；第 7 階段加入 avatar 之間） */
export const relationships = pgTable(
  'relationships',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** user 或另一個 avatar 的 id */
    target: text('target').notNull(),
    stage: text('stage').$type<Stage>().notNull(),
    affinity: integer('affinity').notNull(),
    trust: integer('trust').notNull(),
    events: jsonb('events').$type<RelationshipEventRecord[]>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('relationships_avatar_target_idx').on(t.avatarId, t.target)],
);

/** avatar 的動態狀態 */
export const avatarState = pgTable('avatar_state', {
  avatarId: uuid('avatar_id')
    .primaryKey()
    .references(() => avatars.id, { onDelete: 'cascade' }),
  mood: jsonb('mood').$type<Mood>().notNull(),
  moodUpdatedAt: timestamp('mood_updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** 最後一次反思（整理印象）的時間 */
  reflectedAt: timestamp('reflected_at', { withTimezone: true }),
  /** 主動發話的次數（當地日期 + 次數，換日歸零） */
  proactiveDate: text('proactive_date'),
  proactiveCount: integer('proactive_count').notNull().default(0),
});

/** 每天的生活日誌：主動聊天的話題，也讓 avatar 知道自己今天做了什麼 */
export const lifeLogs = pgTable(
  'life_logs',
  {
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** avatar 所在時區（設定的時區）的日期，YYYY-MM-DD */
    date: text('date').notNull(),
    events: jsonb('events').$type<LifeLogEvent[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.avatarId, t.date] })],
);

/** 事件 log：決策與狀態變化，給監控頁看 */
export const eventLog = pgTable(
  'event_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    level: text('level').$type<EventLevel>().notNull(),
    category: text('category').$type<EventCategory>().notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    avatarId: uuid('avatar_id'),
    conversationId: uuid('conversation_id'),
    traceId: uuid('trace_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('event_log_at_idx').on(t.at), index('event_log_avatar_idx').on(t.avatarId, t.at)],
);

/** LLM 呼叫的完整紀錄（context 與回應）；定期清除 */
export const llmTraces = pgTable(
  'llm_traces',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    purpose: text('purpose').notNull(),
    avatarId: uuid('avatar_id'),
    conversationId: uuid('conversation_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    /** 沒有開啟「記錄完整 context」時為 null */
    request: jsonb('request').$type<TraceDto['request'] | null>(),
    response: text('response'),
    parsed: jsonb('parsed'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    ok: boolean('ok').notNull(),
    error: text('error'),
  },
  (t) => [index('llm_traces_created_idx').on(t.createdAt)],
);
