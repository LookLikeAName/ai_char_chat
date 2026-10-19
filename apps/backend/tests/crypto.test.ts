import { describe, expect, it } from 'vitest';
import { keyHint, SecretBox } from '../src/crypto.ts';

describe('SecretBox', () => {
  it('加密後可以解回原文，且每次密文不同', () => {
    const box = new SecretBox('test-secret-0123456789');
    const a = box.encrypt('sk-abc123');
    const b = box.encrypt('sk-abc123');
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-abc123');
    expect(box.decrypt(a)).toBe('sk-abc123');
  });

  it('APP_SECRET 不同就解不開', () => {
    const sealed = new SecretBox('test-secret-0123456789').encrypt('sk-abc123');
    expect(() => new SecretBox('another-secret-987654').decrypt(sealed)).toThrow();
  });

  it('keyHint 只露出最後 4 碼', () => {
    expect(keyHint('sk-abcdef1234')).toBe('…1234');
  });
});
