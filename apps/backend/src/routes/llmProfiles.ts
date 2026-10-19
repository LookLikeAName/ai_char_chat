import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { llmParamsSchema, llmProfileInputSchema, PROVIDER_TYPES, resolveParams, type LlmParams } from '@acc/shared';
import { keyHint } from '../crypto.ts';
import { llmProfiles } from '../db/schema.ts';
import { HttpError, parseBody } from '../errors.ts';
import { complete, listModels, LlmError, type ResolvedLlm } from '../llm/index.ts';
import {
  getProfile,
  profileToDto,
  profileUsage,
  resolveRow,
  toResolved,
} from '../services/llmProfiles.ts';
import { loadSettings } from '../services/settings.ts';

const idParams = z.object({ id: z.uuid() });

/** 還沒儲存的設定（設定頁的表單內容）；沒有填 apiKey 時沿用 profileId 已存的 key */
const draftSchema = z.object({
  profileId: z.uuid().optional(),
  provider: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().trim().url().nullable().optional(),
  model: z.string().trim().default(''),
  apiKey: z.string().trim().min(1).nullable().optional(),
  params: llmParamsSchema.default({}),
});

const TEST_PROMPT = '請用一句繁體中文自我介紹（20 字以內）。';

export async function llmProfileRoutes(app: FastifyInstance) {
  const { db, box, events } = app.deps;
  const fetchFn = app.deps.fetchFn ?? fetch;

  app.get('/llm-profiles', async () => {
    const [rows, usage] = await Promise.all([
      db.select().from(llmProfiles).orderBy(desc(llmProfiles.createdAt)),
      profileUsage(db),
    ]);
    return rows.map((r) => profileToDto(r, usage.get(r.id) ?? 0));
  });

  app.post('/llm-profiles', async (req, reply) => {
    const input = parseBody(llmProfileInputSchema, req.body);
    const [row] = await db
      .insert(llmProfiles)
      .values({
        name: input.name,
        provider: input.provider,
        baseUrl: input.baseUrl ?? null,
        model: input.model,
        apiKeyEnc: input.apiKey ? box.encrypt(input.apiKey) : null,
        apiKeyHint: input.apiKey ? keyHint(input.apiKey) : null,
        defaults: input.defaults,
      })
      .returning();
    await events.publish({ type: 'llmProfiles.changed' });
    return reply.status(201).send(profileToDto(row!, 0));
  });

  app.put('/llm-profiles/:id', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const input = parseBody(llmProfileInputSchema, req.body);
    await getProfile(db, id);
    const keyFields =
      input.apiKey === undefined
        ? {}
        : input.apiKey === null
          ? { apiKeyEnc: null, apiKeyHint: null }
          : { apiKeyEnc: box.encrypt(input.apiKey), apiKeyHint: keyHint(input.apiKey) };
    const [row] = await db
      .update(llmProfiles)
      .set({
        name: input.name,
        provider: input.provider,
        baseUrl: input.baseUrl ?? null,
        model: input.model,
        defaults: input.defaults,
        ...keyFields,
        updatedAt: new Date(),
      })
      .where(eq(llmProfiles.id, id))
      .returning();
    await events.publish({ type: 'llmProfiles.changed' });
    return profileToDto(row!, (await profileUsage(db)).get(id) ?? 0);
  });

  app.delete('/llm-profiles/:id', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    await getProfile(db, id);
    const used = (await profileUsage(db)).get(id) ?? 0;
    if (used) throw new HttpError(409, `還有 ${used} 個 avatar 綁定這個設定檔，請先改綁其他設定檔`);
    const settings = await loadSettings(db);
    if (settings.utilityLlm?.profileId === id) throw new HttpError(409, '系統工具模型正在使用這個設定檔');
    await db.delete(llmProfiles).where(eq(llmProfiles.id, id));
    await events.publish({ type: 'llmProfiles.changed' });
    return reply.status(204).send();
  });

  /** 測試已儲存的設定檔；可以帶覆寫參數，用來測試 avatar 綁定後的實際效果 */
  app.post('/llm-profiles/:id/test', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const { params } = parseBody(z.object({ params: llmParamsSchema.default({}) }), req.body ?? {});
    const row = await getProfile(db, id);
    return runTest(resolveRow(row, box), resolveParams(row.defaults, params));
  });

  /** 測試表單裡還沒儲存的設定 */
  app.post('/llm-profiles/test-draft', async (req) => {
    const draft = parseBody(draftSchema, req.body);
    if (!draft.model) throw new HttpError(400, '請先填寫模型名稱');
    return runTest(await resolveDraft(draft), draft.params);
  });

  /** 列出供應商可用的模型，給設定頁的模型下拉選單 */
  app.post('/llm-profiles/models', async (req) => {
    const draft = parseBody(draftSchema, req.body);
    try {
      return { models: await listModels(await resolveDraft(draft), fetchFn) };
    } catch (err) {
      if (err instanceof LlmError) throw new HttpError(502, err.message);
      throw err;
    }
  });

  async function resolveDraft(draft: z.infer<typeof draftSchema>): Promise<ResolvedLlm> {
    let apiKey = draft.apiKey ?? undefined;
    if (apiKey === undefined && draft.profileId) {
      const row = await getProfile(db, draft.profileId);
      apiKey = row.apiKeyEnc ? box.decrypt(row.apiKeyEnc) : undefined;
    }
    return toResolved(draft, apiKey);
  }

  async function runTest(llm: ResolvedLlm, params: LlmParams) {
    const started = Date.now();
    try {
      const res = await complete(
        llm,
        { messages: [{ role: 'user', content: TEST_PROMPT }], params, timeoutMs: 30_000 },
        fetchFn,
      );
      return { ok: true as const, reply: res.text.trim(), latencyMs: Date.now() - started, usage: res.usage, params };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false as const, error: err.message, latencyMs: Date.now() - started };
      throw err;
    }
  }
}
