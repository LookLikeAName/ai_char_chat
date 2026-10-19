import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  avatarImageGenerateSchema,
  avatarInputSchema,
  fieldMeta,
  isPersonaEmpty,
  missingFields,
  personaCheckSchema,
  personaGenerateSchema,
  sanitizeDraft,
  type PersonaDraft,
} from '@acc/shared';
import { avatars, conversationMembers, conversations } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import { HttpError, notFound, parseBody } from '../errors.ts';
import { generateImage } from '../images/generate.ts';
import { LlmError } from '../llm/index.ts';
import { checkPersona } from '../persona/check.ts';
import { generatePersona } from '../persona/generate.ts';
import { avatarToDto } from '../services/avatars.ts';
import { assertProfileExists, getProfile, resolveRow } from '../services/llmProfiles.ts';
import { getRelationship } from '../relationship/service.ts';
import { loadSettings } from '../services/settings.ts';

const idParams = z.object({ id: z.uuid() });

/**
 * 人格設定要嘛全空（只靠簡介），要嘛全部填滿；有不合法的值或缺欄位就拒絕。
 * undefined 表示不變更。
 */
function validatePersona(input: Record<string, unknown> | undefined): PersonaDraft | undefined {
  if (input === undefined) return undefined;
  const { draft, errors } = sanitizeDraft(input);
  const bad = Object.entries(errors)[0];
  if (bad) throw new HttpError(400, `${fieldMeta(bad[0])?.label ?? bad[0]}：${bad[1]}`);
  if (isPersonaEmpty(draft)) return {};
  const missing = missingFields(draft);
  if (missing.length) {
    const names = missing.slice(0, 5).map((p) => fieldMeta(p)?.label ?? p);
    throw new HttpError(400, `人格設定還有 ${missing.length} 個欄位沒填（${names.join('、')}${missing.length > 5 ? '…' : ''}），可以用「AI 補完」填滿`);
  }
  return draft;
}

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
    const { timezone } = await loadSettings(db);
    return avatarToDto(row, (await dmMap(db, [row.id])).get(row.id)!, timezone);
  }

  async function changed() {
    await events.publish({ type: 'avatars.changed' });
    await events.publish({ type: 'conversations.changed' });
  }

  app.get('/avatars', async () => {
    const rows = await db.select().from(avatars).orderBy(asc(avatars.createdAt));
    const dms = await dmMap(db, rows.map((r) => r.id));
    const { timezone } = await loadSettings(db);
    return rows.map((r) => avatarToDto(r, dms.get(r.id)!, timezone));
  });

  app.get('/avatars/:id', async (req) => dto(await load(parseBody(idParams, req.params).id)));

  app.post('/avatars', async (req, reply) => {
    const input = parseBody(avatarInputSchema, req.body);
    if (input.llm) await assertProfileExists(db, input.llm.profileId);
    const persona = validatePersona(input.persona) ?? {};
    // 建立 avatar 時一起建立它的一對一聊天
    const row = await db.transaction(async (tx) => {
      const [a] = await tx
        .insert(avatars)
        .values({
          name: input.name,
          bio: input.bio,
          llm: input.llm,
          persona,
          personaLocks: input.personaLocks ?? [],
          dailyTokenLimit: input.dailyTokenLimit ?? 0,
        })
        .returning();
      const [c] = await tx.insert(conversations).values({ type: 'dm' }).returning();
      await tx.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id });
      return a!;
    });
    await getRelationship(db, row.id, 'user', input.initialStage ?? 'stranger');
    await changed();
    return reply.status(201).send(await dto(row));
  });

  app.put('/avatars/:id', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const input = parseBody(avatarInputSchema, req.body);
    await load(id);
    if (input.llm) await assertProfileExists(db, input.llm.profileId);
    const persona = validatePersona(input.persona);
    const [row] = await db
      .update(avatars)
      .set({
        name: input.name,
        bio: input.bio,
        llm: input.llm,
        ...(persona !== undefined ? { persona } : {}),
        ...(input.personaLocks !== undefined ? { personaLocks: input.personaLocks } : {}),
        ...(input.dailyTokenLimit !== undefined ? { dailyTokenLimit: input.dailyTokenLimit } : {}),
        updatedAt: new Date(),
      })
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

  /** 存成新檔、更新 avatar、刪掉舊檔 */
  async function replaceImage(row: typeof avatars.$inferSelect, write: (abs: string) => Promise<void>, ext: string) {
    const rel = `avatars/${row.id}-${randomUUID().slice(0, 8)}.${ext}`;
    const abs = path.join(mediaDir, rel);
    try {
      await write(abs);
    } catch (err) {
      await rm(abs, { force: true });
      throw err;
    }
    const [updated] = await db
      .update(avatars)
      .set({ imagePath: rel, updatedAt: new Date() })
      .where(eq(avatars.id, row.id))
      .returning();
    if (row.imagePath) await rm(path.join(mediaDir, row.imagePath), { force: true });
    await changed();
    return dto(updated!);
  }

  app.post('/avatars/:id/image', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const row = await load(id);
    const file = await req.file();
    if (!file) throw new HttpError(400, '沒有收到檔案');
    const ext = IMAGE_TYPES[file.mimetype];
    if (!ext) throw new HttpError(400, '只接受 PNG、JPEG、WebP、GIF');
    return replaceImage(
      row,
      async (abs) => {
        await pipeline(file.file, createWriteStream(abs));
        if (file.file.truncated) throw new HttpError(413, '圖片不能超過 5 MB');
      },
      ext,
    );
  });

  /** 用設定頁指定的圖片模型生成頭像 */
  app.post('/avatars/:id/image/generate', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const { prompt } = parseBody(avatarImageGenerateSchema, req.body);
    const row = await load(id);
    const settings = await loadSettings(db);
    if (!settings.imageGen) throw new HttpError(400, '請先到「設定 → 一般 → 頭像生成」選擇圖片模型');
    const profile = await getProfile(db, settings.imageGen.profileId);
    const llm = { ...resolveRow(profile, app.deps.box), model: settings.imageGen.model };
    let image;
    try {
      image = await generateImage(llm, prompt, app.deps.fetchFn);
    } catch (err) {
      if (err instanceof LlmError) throw new HttpError(502, `頭像生成失敗：${err.message}`);
      throw err;
    }
    const ext = IMAGE_TYPES[image.mime] ?? 'png';
    return replaceImage(row, (abs) => writeFile(abs, image.data), ext);
  });

  /** AI 補完人格設定（不會儲存，結果回給編輯畫面預覽） */
  app.post('/avatars/persona/generate', async (req) => {
    const input = parseBody(personaGenerateSchema, req.body);
    return generatePersona(app.deps, await loadSettings(db), input);
  });

  /** 一致性檢查 */
  app.post('/avatars/persona/check', async (req) => {
    const input = parseBody(personaCheckSchema, req.body);
    return { issues: await checkPersona(app.deps, await loadSettings(db), input) };
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
