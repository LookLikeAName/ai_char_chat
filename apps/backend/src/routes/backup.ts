// 匯出／匯入設定：一般設定、LLM 設定檔（可選擇帶 API key）、玩家 profile。
// 設定裡指向設定檔的地方用原本的 id 當參照，匯入時對應到新建立（或沿用）的設定檔。
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import {
  appSettingsSchema,
  isValidTimezone,
  llmProfileInputSchema,
  preferencesSchema,
  SETTINGS_FORMAT,
  SETTINGS_VERSION,
  settingsExportOptionsSchema,
  settingsImportSchema,
  UTILITY_TASK_LABELS,
  type AppSettings,
  type ExportedProfile,
  type SettingsFile,
  type SettingsImportResultDto,
  type UtilityTask,
} from '@acc/shared';
import { keyHint } from '../crypto.ts';
import { llmProfiles } from '../db/schema.ts';
import { HttpError, parseBody } from '../errors.ts';
import { loadProfile, replaceProfile } from '../profile/service.ts';
import { loadSettings, saveSettings } from '../services/settings.ts';

type ProfileRow = typeof llmProfiles.$inferSelect;

/** 同一個設定檔：用途、供應商、端點、模型、名字都一樣 */
const sameProfile = (row: ProfileRow, p: ExportedProfile) =>
  row.kind === p.kind && row.provider === p.provider && (row.baseUrl ?? null) === (p.baseUrl ?? null) && row.model === p.model && row.name === p.name;

export async function backupRoutes(app: FastifyInstance) {
  const { db, box, events } = app.deps;

  app.get('/settings/export', async (req, reply) => {
    const opts = parseBody(settingsExportOptionsSchema, req.query);
    const settings = await loadSettings(db);
    const rows = await db.select().from(llmProfiles).orderBy(asc(llmProfiles.createdAt));
    const file: SettingsFile = {
      format: SETTINGS_FORMAT,
      version: SETTINGS_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      profiles: rows.map((r) => ({
        ref: r.id,
        kind: r.kind,
        name: r.name,
        provider: r.provider,
        baseUrl: r.baseUrl,
        model: r.model,
        ...(opts.apiKeys && r.apiKeyEnc ? { apiKey: box.decrypt(r.apiKeyEnc) } : {}),
        defaults: r.defaults,
        pricing: r.pricing ?? null,
        vision: r.vision,
        fallback: r.fallback ? { ref: r.fallback.profileId, onRefusal: r.fallback.onRefusal, onError: r.fallback.onError } : null,
      })),
    };
    if (opts.player) {
      const p = await loadProfile(db);
      file.player = { preferences: p.preferences, answers: p.answers, summary: p.summary };
    }
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-disposition', `attachment; filename="settings-${date}.json"; filename*=UTF-8''${encodeURIComponent(`設定-${date}.json`)}`)
      .send(file);
  });

  app.post('/settings/import', { bodyLimit: 8 * 1024 * 1024 }, async (req): Promise<SettingsImportResultDto> => {
    const { file, include } = parseBody(settingsImportSchema, req.body);
    const result: SettingsImportResultDto = { profiles: { created: 0, reused: 0, keys: 0 }, settings: false, player: false, warnings: [] };

    // 先全部檢查過再寫入
    const inputs = file.profiles.map((p) => {
      // 備援等設定檔都建立好之後再接上
      const r = llmProfileInputSchema.safeParse({ ...p, apiKey: p.apiKey ?? undefined, fallback: null });
      if (!r.success) throw new HttpError(400, `設定檔「${p.name}」：${r.error.issues[0]?.message ?? '格式不正確'}`);
      return { p, input: r.data };
    });
    let preferences = null;
    if (include.player && file.player?.preferences) {
      const r = preferencesSchema.safeParse(file.player.preferences);
      if (!r.success) throw new HttpError(400, '玩家 profile 的偏好問卷格式不正確');
      preferences = r.data;
    }

    // 設定檔：一樣的就沿用（檔案有 key、現有的沒有時補上），其他的建立新的
    const refs = new Map<string, string>();
    const existing = await db.select().from(llmProfiles);
    await db.transaction(async (tx) => {
      for (const { p, input } of inputs) {
        const same = existing.find((row) => sameProfile(row, p));
        if (same) {
          refs.set(p.ref, same.id);
          result.profiles.reused++;
          if (include.profiles && input.apiKey && !same.apiKeyEnc) {
            await tx
              .update(llmProfiles)
              .set({ apiKeyEnc: box.encrypt(input.apiKey), apiKeyHint: keyHint(input.apiKey), updatedAt: new Date() })
              .where(eq(llmProfiles.id, same.id));
            result.profiles.keys++;
          }
          continue;
        }
        if (!include.profiles) continue;
        const [row] = await tx
          .insert(llmProfiles)
          .values({
            kind: input.kind,
            name: input.name,
            provider: input.provider,
            baseUrl: input.baseUrl ?? null,
            model: input.model,
            apiKeyEnc: input.apiKey ? box.encrypt(input.apiKey) : null,
            apiKeyHint: input.apiKey ? keyHint(input.apiKey) : null,
            defaults: input.defaults,
            pricing: input.pricing,
            vision: input.vision,
          })
          .returning();
        refs.set(p.ref, row!.id);
        result.profiles.created++;
        if (input.apiKey) result.profiles.keys++;
      }
      // 備援：新建立的設定檔接上檔案裡指定的備援（沿用的設定檔維持原本的）
      for (const { p } of inputs) {
        const id = refs.get(p.ref);
        if (!p.fallback || !id || existing.some((e) => e.id === id)) continue;
        const target = refs.get(p.fallback.ref);
        if (!target || target === id) {
          result.warnings.push(`「${p.name}」的備援設定檔沒有匯入，請重新選擇`);
          continue;
        }
        await tx
          .update(llmProfiles)
          .set({ fallback: { profileId: target, onRefusal: p.fallback.onRefusal, onError: p.fallback.onError } })
          .where(eq(llmProfiles.id, id));
      }
    });

    if (include.settings) {
      const parsed = appSettingsSchema.safeParse(file.settings);
      if (!parsed.success) throw new HttpError(400, `一般設定格式不正確：${parsed.error.issues[0]?.message ?? ''}`);
      const next = remapProfiles(parsed.data, refs, result.warnings);
      if (!isValidTimezone(next.timezone)) {
        result.warnings.push(`時區「${next.timezone}」無效，保留原本的時區`);
        next.timezone = (await loadSettings(db)).timezone;
      }
      await saveSettings(db, next);
      result.settings = true;
      await events.publish({ type: 'settings.changed' });
    }

    if (include.player && file.player) {
      await replaceProfile(db, { preferences, answers: file.player.answers, summary: file.player.summary });
      result.player = true;
    }
    if (result.profiles.created || result.profiles.keys) await events.publish({ type: 'llmProfiles.changed' });
    return result;
  });
}

/** 把設定裡的設定檔參照換成這台的 id；找不到的清掉並提醒 */
function remapProfiles(s: AppSettings, refs: Map<string, string>, warnings: string[]): AppSettings {
  const map = <T extends { profileId: string }>(b: T | null, label: string): T | null => {
    if (!b) return null;
    const id = refs.get(b.profileId);
    if (!id) warnings.push(`「${label}」用的設定檔沒有匯入，請重新選擇`);
    return id ? { ...b, profileId: id } : null;
  };
  const byTask: AppSettings['utilityByTask'] = {};
  for (const [task, b] of Object.entries(s.utilityByTask) as [UtilityTask, NonNullable<AppSettings['utilityByTask'][UtilityTask]>][]) {
    const m = map(b, `系統工具模型：${UTILITY_TASK_LABELS[task].title}`);
    if (m) byTask[task] = m;
  }
  return {
    ...s,
    utilityLlm: map(s.utilityLlm, '系統工具模型'),
    utilityByTask: byTask,
    imageGen: map(s.imageGen, '頭像與照片生成'),
    embedding: map(s.embedding, '記憶'),
  };
}
