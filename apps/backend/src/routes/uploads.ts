// 聊天用的圖片：先上傳拿到 id，送出訊息時帶上。沒被任何訊息用到的檔案，定期整理時會刪掉。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UploadDto } from '@acc/shared';
import { HttpError } from '../errors.ts';
import { inspectImage, type ImageInfo } from '../images/inspect.ts';
import { mediaUrl } from '../services/avatars.ts';

export const UPLOAD_DIR = 'uploads';

/** 送出訊息時檢查上傳的檔案還在、而且真的是圖片 */
export async function readUpload(mediaDir: string, id: string): Promise<{ path: string } & ImageInfo> {
  const rel = `${UPLOAD_DIR}/${id}`;
  const buf = await readFile(path.join(mediaDir, rel)).catch(() => null);
  const info = buf && inspectImage(buf);
  if (!info) throw new HttpError(400, '找不到上傳的圖片，請重新選擇');
  return { path: rel, ...info };
}

export async function uploadRoutes(app: FastifyInstance) {
  const { mediaDir } = app.deps;

  app.post('/uploads', async (req): Promise<UploadDto> => {
    const file = await req.file();
    if (!file) throw new HttpError(400, '沒有收到檔案');
    const buf = await file.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, '圖片不能超過 5 MB');
      throw err;
    });
    const info = inspectImage(buf);
    if (!info) throw new HttpError(400, '只接受 PNG、JPEG、WebP、GIF');
    const id = `${randomUUID()}.${info.ext}`;
    await writeFile(path.join(mediaDir, UPLOAD_DIR, id), buf);
    return { id, url: mediaUrl(`${UPLOAD_DIR}/${id}`)!, width: info.width, height: info.height };
  });
}
