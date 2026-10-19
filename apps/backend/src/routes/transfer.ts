// 匯出／匯入 avatar：設定、頭像，可選擇帶記憶與關係、一對一聊天紀錄。不含 API key。
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  exportOptionsSchema,
  importRequestSchema,
  INITIAL_VALUES,
  PERSONA_PATHS,
  TRANSFER_FORMAT,
  TRANSFER_MAX_MESSAGES,
  TRANSFER_VERSION,
  type AvatarCard,
  type ImportResultDto,
  type InitialStage,
  type TransferFile,
} from '@acc/shared';
import { avatarLinks, avatars, avatarState, conversationMembers, conversations, memories, messages, relationships } from '../db/schema.ts';
import { notFound, parseBody } from '../errors.ts';
import { embedderFromSettings } from '../memory/embedder.ts';
import { backfillEmbeddings } from '../memory/store.ts';
import { loadLinks } from '../services/avatarLinks.ts';
import { avatarPhoto, validatePersona } from '../services/avatars.ts';
import { assertProfileExists } from '../services/llmProfiles.ts';
import { loadSettings } from '../services/settings.ts';
import { IMAGE_TYPES } from './avatars.ts';

const idParams = z.object({ id: z.uuid() });
const MIME_BY_EXT = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([mime, ext]) => [ext, mime]));
/** 頭像最多 5 MB，轉成 base64 再加上聊天紀錄 */
const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

export async function transferRoutes(app: FastifyInstance) {
  const { db, events, box, mediaDir } = app.deps;

  async function dmOf(avatarId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ id: conversations.id })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(and(eq(conversationMembers.avatarId, avatarId), eq(conversations.type, 'dm')));
    return row?.id;
  }

  async function card(row: typeof avatars.$inferSelect, opts: z.infer<typeof exportOptionsSchema>): Promise<AvatarCard> {
    const readImage = async (file: string | null): Promise<AvatarCard['image']> => {
      if (!file) return null;
      const mime = MIME_BY_EXT[path.extname(file).slice(1)];
      const data = await readFile(path.join(mediaDir, file)).catch(() => null);
      return mime && data ? { mime: mime as NonNullable<AvatarCard['image']>['mime'], data: data.toString('base64') } : null;
    };
    const out: AvatarCard = {
      name: row.name,
      displayName: row.displayName,
      bio: row.bio,
      persona: row.persona as Record<string, unknown>,
      personaLocks: row.personaLocks,
      llmParams: row.llm?.params ?? {},
      dailyTokenLimit: row.dailyTokenLimit,
      image: await readImage(row.imagePath),
      photo: avatarPhoto(row),
      photoReference: await readImage(row.photoReferencePath),
    };
    if (opts.memories) {
      const [[rel], [state], mems] = await Promise.all([
        db
          .select()
          .from(relationships)
          .where(and(eq(relationships.avatarId, row.id), eq(relationships.target, 'user'))),
        db.select().from(avatarState).where(eq(avatarState.avatarId, row.id)),
        // 關於其他 avatar 的記憶帶過去也對不上人，不匯出
        db
          .select()
          .from(memories)
          .where(and(eq(memories.avatarId, row.id), inArray(memories.about, ['user', 'self'])))
          .orderBy(asc(memories.createdAt)),
      ]);
      out.relationship = rel ? { stage: rel.stage, affinity: rel.affinity, trust: rel.trust, events: rel.events } : null;
      out.mood = state?.mood ?? null;
      out.memories = mems.map((m) => ({
        kind: m.kind,
        content: m.content,
        importance: m.importance,
        about: m.about as 'user' | 'self',
        createdAt: m.createdAt.toISOString(),
      }));
    }
    if (opts.history) {
      const dm = await dmOf(row.id);
      const rows = dm
        ? await db
            .select({ sender: messages.senderType, content: messages.content, createdAt: messages.createdAt, meta: messages.meta })
            .from(messages)
            .where(and(eq(messages.conversationId, dm), inArray(messages.senderType, ['user', 'avatar'])))
            .orderBy(desc(messages.createdAt), desc(messages.seq))
            .limit(TRANSFER_MAX_MESSAGES)
        : [];
      // 圖片不匯出，用文字標記（也保留它的描述，avatar 之後還記得傳過什麼）
      const text = (m: (typeof rows)[number]) => {
        const img = m.meta.image;
        const tag = img ? `［${m.sender === 'avatar' ? '照片' : '圖片'}${img.description || img.caption ? `：${img.description ?? img.caption}` : ''}］` : '';
        return [tag, m.content].filter(Boolean).join(' ').slice(0, 4000);
      };
      out.messages = rows
        .reverse()
        .map((m) => ({ sender: m.sender as 'user' | 'avatar', content: text(m), createdAt: m.createdAt.toISOString() }))
        .filter((m) => m.content);
    }
    return out;
  }

  function file(cards: AvatarCard[]): TransferFile {
    return { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, exportedAt: new Date().toISOString(), avatars: cards };
  }

  function attachment(name: string) {
    const date = new Date().toISOString().slice(0, 10);
    return `attachment; filename="avatar-${date}.json"; filename*=UTF-8''${encodeURIComponent(`${name}-${date}.json`)}`;
  }

  /** 全部的 avatar（備份用） */
  app.get('/avatars/export', async (req, reply) => {
    const opts = parseBody(exportOptionsSchema, req.query);
    const rows = await db.select().from(avatars).orderBy(asc(avatars.createdAt));
    const links = await loadLinks(db);
    const index = new Map(rows.map((r, i) => [r.id, i]));
    const cards = [];
    for (const r of rows) {
      const c = await card(r, opts);
      const own = (links.get(r.id) ?? []).flatMap((l) => (index.has(l.avatarId) ? [{ index: index.get(l.avatarId)!, relation: l.relation, stage: l.stage }] : []));
      cards.push(own.length ? { ...c, links: own } : c);
    }
    return reply.header('content-disposition', attachment('avatars')).send(file(cards));
  });

  app.get('/avatars/:id/export', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    const opts = parseBody(exportOptionsSchema, req.query);
    const [row] = await db.select().from(avatars).where(eq(avatars.id, id));
    if (!row) throw notFound('avatar');
    return reply.header('content-disposition', attachment(row.name)).send(file([await card(row, opts)]));
  });

  /** 匯入：每個 avatar 都是新的（不會覆蓋同名的），各自有新的一對一聊天 */
  app.post('/avatars/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (req): Promise<ImportResultDto> => {
    const { file: input, profileId, include } = parseBody(importRequestSchema, req.body);
    if (profileId) await assertProfileExists(db, profileId, 'chat');
    // 先全部檢查過，有一個不合格就整批不匯入
    const prepared = input.avatars.map((c, i) => {
      try {
        return { c, persona: validatePersona(c.persona) ?? {} };
      } catch (err) {
        throw Object.assign(err as Error, { message: `第 ${i + 1} 個（${c.name}）：${(err as Error).message}` });
      }
    });

    const result: ImportResultDto['avatars'] = [];
    const written: string[] = [];
    try {
      // 整批在同一個交易裡：中途失敗就全部不算
      await db.transaction(async (tx) => {
        for (const { c, persona } of prepared) {
          const save = async (img: AvatarCard['image'] | undefined, kind: string) => {
            if (!img) return null;
            const rel = `avatars/${randomUUID()}${kind}.${IMAGE_TYPES[img.mime]}`;
            await writeFile(path.join(mediaDir, rel), Buffer.from(img.data, 'base64'));
            written.push(rel);
            return rel;
          };
          const imagePath = await save(c.image, '');
          const photoReferencePath = await save(c.photoReference, '-ref');
          const msgs = include.history ? (c.messages ?? []) : [];
          const mems = include.memories ? (c.memories ?? []) : [];
          const [a] = await tx
            .insert(avatars)
            .values({
              name: c.name,
              displayName: c.displayName,
              bio: c.bio,
              imagePath,
              persona,
              personaLocks: c.personaLocks.filter((p) => PERSONA_PATHS.includes(p)),
              llm: profileId ? { profileId, params: c.llmParams } : null,
              dailyTokenLimit: c.dailyTokenLimit,
              photo: c.photo ?? {},
              photoReferencePath,
            })
            .returning();
          const avatarId = a!.id;
          const last = msgs.at(-1) ? new Date(msgs.at(-1)!.createdAt) : null;
          const [conv] = await tx
            .insert(conversations)
            .values({ type: 'dm', lastMessageAt: last, userReadAt: last })
            .returning();
          // 匯入的紀錄都當作已讀、已回、記憶已整理過，不會觸發回覆或重新萃取
          await tx
            .insert(conversationMembers)
            .values({ conversationId: conv!.id, avatarId, seenUpTo: last, handledUpTo: last, memoryUpTo: last });
          if (msgs.length) {
            await tx.insert(messages).values(
              msgs.map((m) => ({
                conversationId: conv!.id,
                senderType: m.sender,
                senderAvatarId: m.sender === 'avatar' ? avatarId : null,
                content: m.content,
                createdAt: new Date(m.createdAt),
              })),
            );
          }
          const rel = include.memories ? c.relationship : null;
          await tx.insert(relationships).values({
            avatarId,
            target: 'user',
            stage: rel?.stage ?? 'stranger',
            affinity: rel?.affinity ?? INITIAL_VALUES.stranger.affinity,
            trust: rel?.trust ?? INITIAL_VALUES.stranger.trust,
            events: rel?.events ?? [],
          });
          if (include.memories && c.mood) await tx.insert(avatarState).values({ avatarId, mood: c.mood });
          if (mems.length) {
            await tx.insert(memories).values(
              mems.map((m) => ({
                avatarId,
                kind: m.kind,
                content: m.content,
                importance: m.importance,
                about: m.about,
                sourceConversationId: conv!.id,
                visibility: 'private',
                createdAt: new Date(m.createdAt),
                lastAccessedAt: new Date(m.createdAt),
              })),
            );
          }
          const created = { id: avatarId, dmConversationId: conv!.id };
          result.push({ ...created, name: c.name, memories: mems.length, messages: msgs.length });
        }
        // 檔案裡互相關聯的 avatar（每一對只存一次，a_id < b_id）
        const pairs = new Map<string, { aId: string; bId: string; relation: string; stage: InitialStage }>();
        prepared.forEach(({ c }, i) => {
          for (const l of c.links ?? []) {
            const other = result[l.index];
            if (!other || l.index === i) continue;
            const [aId, bId] = [result[i]!.id, other.id].sort() as [string, string];
            if (!pairs.has(`${aId}:${bId}`)) pairs.set(`${aId}:${bId}`, { aId, bId, relation: l.relation, stage: l.stage });
          }
        });
        if (pairs.size) {
          await tx.insert(avatarLinks).values([...pairs.values()]);
          await tx
            .insert(relationships)
            .values(
              [...pairs.values()].flatMap((p) => [
                { avatarId: p.aId, target: `avatar:${p.bId}`, stage: p.stage, ...INITIAL_VALUES[p.stage] },
                { avatarId: p.bId, target: `avatar:${p.aId}`, stage: p.stage, ...INITIAL_VALUES[p.stage] },
              ]),
            )
            .onConflictDoNothing();
        }
      });
    } catch (err) {
      for (const p of written) await rm(path.join(mediaDir, p), { force: true });
      throw err;
    }

    // 記憶的向量用目前設定的嵌入模型重算（失敗也沒關係，之後的定期整理會補）
    const settings = await loadSettings(db);
    const embedder = await embedderFromSettings(db, box, settings, app.deps.fetchFn).catch(() => null);
    if (embedder) {
      for (const r of result) if (r.memories) await backfillEmbeddings(db, embedder, r.id, 500).catch(() => 0);
    }
    await events.publish({ type: 'avatars.changed' });
    await events.publish({ type: 'conversations.changed' });
    return { avatars: result };
  });
}
