import type { FastifyInstance } from 'fastify';
import { adultTestSchema, appSettingsPatchSchema, appSettingsSchema, isValidTimezone } from '@acc/shared';
import { HttpError, parseBody } from '../errors.ts';
import { runAdultTest } from '../services/adultTest.ts';
import { assertProfileExists, getProfile } from '../services/llmProfiles.ts';
import { loadSettings, saveSettings } from '../services/settings.ts';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', async () => loadSettings(app.deps.db));

  app.patch('/settings', async (req) => {
    const { db, events } = app.deps;
    const patch = parseBody(appSettingsPatchSchema, req.body);
    const next = appSettingsSchema.parse({ ...(await loadSettings(db)), ...patch });
    if (!isValidTimezone(next.timezone)) throw new HttpError(400, `無效的時區：${next.timezone}`);
    if (next.utilityLlm) await assertProfileExists(db, next.utilityLlm.profileId, 'chat');
    if (next.embedding) await assertProfileExists(db, next.embedding.profileId, 'embedding');
    if (next.imageGen) await assertProfileExists(db, next.imageGen.profileId, 'image');
    await saveSettings(db, next);
    await events.publish({ type: 'settings.changed' });
    return next;
  });

  /** 測試聊天模型能不能寫成人內容：會真的呼叫一次模型（加上判斷，最多兩次） */
  app.post('/settings/adult-test', async (req) => {
    const { db } = app.deps;
    const { profileId } = parseBody(adultTestSchema, req.body);
    await assertProfileExists(db, profileId, 'chat');
    const profile = await getProfile(db, profileId);
    return runAdultTest(app.deps, await loadSettings(db), profile);
  });
}
