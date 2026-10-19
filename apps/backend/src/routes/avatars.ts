import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { avatarInputSchema } from '@acc/shared';
import { avatars, conversationMembers, conversations } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import { HttpError, notFound, parseBody } from '../errors.ts';
import { avatarToDto } from '../services/avatars.ts';
import { assertProfileExists } from '../services/llmProfiles.ts';

const idParams = z.object({ id: z.uuid() });

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** avatar id → 一對一聊天的 id */
async function dmMap(db: Db, avatarIds: string[]): Promise<Map<string, string>> {
  if (!avatarIds.length) return new Map();
  const rows = await db
    .select({ avatarId: conversationMembers.avatarId, conversationId: conversations.id })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(and(eq(conversations.type, 'dm'), inArray(conversationMembers.avatarId, avatarIds)));
  return new Map(rows.map((r) => [r.avatarId, r.conversationId]));
}

export async function avatarRoutes(app: FastifyInstance) {
  const { db, events, mediaDir } = app.deps;

  async function load(id: string) {
    const [row] = await db.select().from(avatars).where(eq(avatars.id, id));
    if (!row) throw notFound('avatar');
    return row;
  }

  async function dto(row: typeof avatars.$inferSelect) {
    return avatarToDto(row, (await dmMap(db, [row.id])).get(row.id)!);
  }

  async function changed() {
    await events.publish({ type: 'avatars.changed' });
    await events.publish({ type: 'conversations.changed' });
  }

  app.get('/avatars', async () => {
    const rows = await db.select().from(avatars).orderBy(asc(avatars.createdAt));
    const dms = await dmMap(db, rows.map((r) => r.id));
    return rows.map((r) => avatarToDto(r, dms.get(r.id)!));
  });

  app.get('/avatars/:id', async (req) => dto(await load(parseBody(idParams, req.params).id)));

  app.post('/avatars', async (req, reply) => {
    const input = parseBody(avatarInputSchema, req.body);
    if (input.llm) await assertProfileExists(db, input.llm.profileId);
    // 建立 avatar 時一起建立它的一對一聊天
    const row = await db.transaction(async (tx) => {
      const [a] = await tx.insert(avatars).values({ name: input.name, bio: input.bio, llm: input.llm }).returning();
      const [c] = await tx.insert(conversations).values({ type: 'dm' }).returning();
      await tx.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id });
      return a!;
    });
    await changed();
    return reply.status(201).send(await dto(row));
  });

  app.put('/avatars/:id', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const input = parseBody(avatarInputSchema, req.body);
    await load(id);
    if (input.llm) await assertProfileExists(db, input.llm.profileId);
    const [row] = await db
      .update(avatars)
      .set({ name: input.name, bio: input.bio, llm: input.llm, updatedAt: new Date() })
      .where(eq(avatars.id, id))
      .returning();
    await changed();
    return dto(row!);
  });

  app.delete('/avatars/:id', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    const row = await load(id);
    const dmId = (await dmMap(db, [id])).get(id);
    await db.transaction(async (tx) => {
      if (dmId) await tx.delete(conversations).where(eq(conversations.id, dmId));
      await tx.delete(avatars).where(eq(avatars.id, id));
    });
    if (row.imagePath) await rm(path.join(mediaDir, row.imagePath), { force: true });
    await changed();
    return reply.status(204).send();
  });

  app.post('/avatars/:id/image', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const row = await load(id);
    const file = await req.file();
    if (!file) throw new HttpError(400, '沒有收到檔案');
    const ext = IMAGE_TYPES[file.mimetype];
    if (!ext) throw new HttpError(400, '只接受 PNG、JPEG、WebP、GIF');
    const rel = `avatars/${id}-${randomUUID().slice(0, 8)}.${ext}`;
    const abs = path.join(mediaDir, rel);
    await pipeline(file.file, createWriteStream(abs));
    if (file.file.truncated) {
      await rm(abs, { force: true });
      throw new HttpError(413, '圖片不能超過 5 MB');
    }
    const [updated] = await db
      .update(avatars)
      .set({ imagePath: rel, updatedAt: new Date() })
      .where(eq(avatars.id, id))
      .returning();
    if (row.imagePath) await rm(path.join(mediaDir, row.imagePath), { force: true });
    await changed();
    return dto(updated!);
  });

  app.delete('/avatars/:id/image', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const row = await load(id);
    const [updated] = await db
      .update(avatars)
      .set({ imagePath: null, updatedAt: new Date() })
      .where(eq(avatars.id, id))
      .returning();
    if (row.imagePath) await rm(path.join(mediaDir, row.imagePath), { force: true });
    await changed();
    return dto(updated!);
  });
}
