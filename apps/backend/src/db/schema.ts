import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { LlmBinding, LlmParams, ProviderType } from '@acc/shared';

export interface MessageMeta {
  /** avatar 這一輪回覆的內心想法（只存在第一則） */
  innerThought?: string;
  /** 系統訊息的種類 */
  systemKind?: 'error' | 'notice';
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
  ...timestamps,
});

export const avatars = pgTable('avatars', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  bio: text('bio').notNull().default(''),
  imagePath: text('image_path'),
  /** 完整人格設定（第 3 階段） */
  persona: jsonb('persona').notNull().default({}),
  llm: jsonb('llm').$type<LlmBinding | null>(),
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
    ok: boolean('ok').notNull(),
    error: text('error'),
  },
  (t) => [index('usage_log_created_idx').on(t.createdAt)],
);
