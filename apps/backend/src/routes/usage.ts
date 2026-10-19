import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../errors.ts';
import { usageSummary } from '../services/usage.ts';

export async function usageRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  /** 用量統計：最近 N 天（含今天），依 avatar、用途、模型、日期分組 */
  app.get('/usage', async (req) => {
    const { days } = parseBody(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), req.query);
    return usageSummary(db, days);
  });
}
