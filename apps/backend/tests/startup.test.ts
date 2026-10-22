// 啟動時等資料庫：主機重開機後 PostgreSQL 可能還在復原
import { describe, expect, it } from 'vitest';
import { isDbNotReady, waitForDb } from '../src/db/client.ts';

const starting = Object.assign(new Error('the database system is starting up'), { code: '57P03' });

describe('waitForDb', () => {
  it('資料庫還在啟動或復原時等它，好了就繼續；間隔逐漸拉長', async () => {
    let n = 0;
    const waits: number[] = [];
    const logs: string[] = [];
    const pool = {
      query: async () => {
        n++;
        if (n === 1) throw Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' });
        if (n < 4) throw starting;
        return { rows: [] };
      },
    };
    await waitForDb(pool as never, { sleep: async (ms) => void waits.push(ms), log: (m) => logs.push(m) });
    expect(n).toBe(4);
    expect(waits).toEqual([1000, 1500, 2250]);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('可以連線');
  });

  it('其他錯誤（例如密碼錯）直接拋出；等太久也放棄', async () => {
    const bad = { query: async () => Promise.reject(Object.assign(new Error('password authentication failed'), { code: '28P01' })) };
    await expect(waitForDb(bad as never, { sleep: async () => {}, log: () => {} })).rejects.toThrow('password');
    const never = { query: async () => Promise.reject(starting) };
    await expect(waitForDb(never as never, { timeoutMs: -1, sleep: async () => {}, log: () => {} })).rejects.toThrow('starting up');
  });

  it('包在 drizzle 錯誤裡的原因也認得', () => {
    expect(isDbNotReady(Object.assign(new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"'), { cause: starting }))).toBe(true);
    expect(isDbNotReady(new Error('relation "x" does not exist'))).toBe(false);
  });
});
