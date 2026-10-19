// API key 以 AES-256-GCM 加密後才存進資料庫；金鑰由 APP_SECRET 衍生。
// 格式：v1:<iv base64>:<tag base64>:<ciphertext base64>
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export class SecretBox {
  private readonly key: Buffer;

  constructor(appSecret: string) {
    this.key = scryptSync(appSecret, 'ai-char-chat/api-keys', 32);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(sealed: string): string {
    const [v, iv, tag, enc] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || !enc) throw new Error('無法辨識的加密格式');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** 只顯示最後 4 碼，讓使用者分辨是哪一把 key */
export function keyHint(plain: string): string {
  return `…${plain.slice(-4)}`;
}
