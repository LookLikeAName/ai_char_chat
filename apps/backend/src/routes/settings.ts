import type { FastifyInstance } from 'fastify';
import { appSettingsPatchSchema, appSettingsSchema, isValidTimezone } from '@acc/shared';
import { HttpError, parseBody } from '../errors.ts';
import { assertProfileExists } from '../services/llmProfiles.ts';
import { loadSettings, saveSettings } from '../services/settings.ts';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', async () => loadSettings(app.deps.db));

  app.patch('/settings', async (req) => {
    const { db, events } = app.deps;
    const patch = parseBody(appSettingsPatchSchema, req.body);
    const next = appSettingsSchema.parse({ ...(await loadSettings(db)), ...patch });
    if (!isValidTimezone(next.timezone)) throw new HttpError(400, `無效的時區：${next.timezone}`);
    if (next.utilityLlm) await assertProfileExists(db, next.utilityLlm.profileId);
    await saveSettings(db, next);
    await events.publish({ type: 'settings.changed' });
    return next;
  });
}
