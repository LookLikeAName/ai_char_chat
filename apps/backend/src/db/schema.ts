import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { LlmBinding, LlmParams, ProviderType } from '@acc/shared';

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
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.avatarId] }), index('conversation_members_avatar_idx').on(t.avatarId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').$type<'user' | 'avatar' | 'system'>().notNull(),
    senderAvatarId: uuid('sender_avatar_id').references(() => avatars.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_created_idx').on(t.conversationId, t.createdAt)],
);
