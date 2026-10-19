import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseBody<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}：` : '';
    throw new HttpError(400, `${where}${first?.message ?? '輸入格式錯誤'}`, r.error.issues);
  }
  return r.data;
}

export const notFound = (what: string) => new HttpError(404, `找不到${what}`);
