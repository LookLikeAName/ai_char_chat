import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answersPatchSchema, preferencesSchema } from '@acc/shared';
import { parseBody } from '../errors.ts';
import { generateSummary, loadProfile, patchAnswers, savePreferences, setSummary } from '../profile/service.ts';
import { loadSettings } from '../services/settings.ts';

export async function profileRoutes(app: FastifyInstance) {
  const { db, events } = app.deps;
  const changed = () => events.publish({ type: 'profile.changed' });

  app.get('/profile', async () => loadProfile(db));

  app.put('/profile/preferences', async (req) => {
    const res = await savePreferences(db, parseBody(preferencesSchema, req.body));
    await changed();
    return res;
  });

  app.patch('/profile/answers', async (req) => {
    const { instrument, answers } = parseBody(answersPatchSchema, req.body);
    const res = await patchAnswers(db, instrument, answers);
    await changed();
    return res;
  });

  app.put('/profile/summary', async (req) => {
    const { summary } = parseBody(z.object({ summary: z.string().trim().max(3000) }), req.body);
    const res = await setSummary(db, summary);
    await changed();
    return res;
  });

  app.post('/profile/summary/generate', async () => {
    const res = await generateSummary(app.deps, await loadSettings(db));
    await changed();
    return res;
  });
}
