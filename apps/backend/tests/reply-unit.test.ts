import { describe, expect, it } from 'vitest';
import { parseReplyOutput, plainTextFallback } from '../src/reply/output.ts';
import { buildHistory, buildSystemPrompt, formatGap } from '../src/reply/prompt.ts';
import { typingMs } from '../src/reply/timing.ts';

describe('parseReplyOutput', () => {
  it('解析標準格式', () => {
    expect(parseReplyOutput('{"inner_thought":"他好可愛","messages":["嗨","今天好累"]}')).toEqual({
      innerThought: '他好可愛',
      messages: ['嗨', '今天好累'],
    });
  });
  it('容許 ```json 包裝與前後的多餘文字', () => {
    expect(parseReplyOutput('好的：\n```json\n{"messages":["嗨"]}\n```')?.messages).toEqual(['嗨']);
  });
  it('messages 是字串、或用 message 欄位也可以', () => {
    expect(parseReplyOutput('{"messages":"嗨"}')?.messages).toEqual(['嗨']);
    expect(parseReplyOutput('{"message":"嗨"}')?.messages).toEqual(['嗨']);
  });
  it('去掉空白訊息，最多 6 則', () => {
    const out = parseReplyOutput(JSON.stringify({ messages: [' ', 'a', 'b', 'c', 'd', 'e', 'f', 'g'] }));
    expect(out?.messages).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
  it('不是 JSON 或沒有訊息時回傳 null', () => {
    expect(parseReplyOutput('嗨嗨')).toBeNull();
    expect(parseReplyOutput('{"messages":[]}')).toBeNull();
  });
});

describe('plainTextFallback', () => {
  it('純文字依空行拆成多則', () => {
    expect(plainTextFallback('嗨\n\n你在幹嘛')?.messages).toEqual(['嗨', '你在幹嘛']);
  });
  it('壞掉的 JSON 不當成訊息', () => {
    expect(plainTextFallback('{"messages": ["嗨"')).toBeNull();
    expect(plainTextFallback('好 "messages": [')).toBeNull();
  });
});

describe('prompt', () => {
  const t = (iso: string) => new Date(iso);

  it('對話紀錄：同一方的連續訊息合併，avatar 的回合寫成 JSON', () => {
    const msgs = buildHistory([
      { senderType: 'user', content: '嗨', createdAt: t('2026-10-19T10:00:00Z') },
      { senderType: 'user', content: '在嗎', createdAt: t('2026-10-19T10:00:05Z') },
      { senderType: 'avatar', content: '在', createdAt: t('2026-10-19T10:01:00Z') },
      { senderType: 'avatar', content: '怎麼了', createdAt: t('2026-10-19T10:01:03Z') },
      { senderType: 'user', content: '沒事', createdAt: t('2026-10-19T13:30:00Z') },
    ]);
    expect(msgs).toEqual([
      { role: 'user', content: '嗨\n在嗎' },
      { role: 'assistant', content: '{"messages":["在","怎麼了"]}' },
      { role: 'user', content: '（3 小時後）沒事' },
    ]);
  });

  it('紀錄超過字數上限時捨棄最舊的', () => {
    const long = 'x'.repeat(9000);
    const msgs = buildHistory([
      { senderType: 'user', content: long, createdAt: t('2026-10-19T10:00:00Z') },
      { senderType: 'avatar', content: long, createdAt: t('2026-10-19T10:01:00Z') },
      { senderType: 'user', content: '最新', createdAt: t('2026-10-19T10:02:00Z') },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('system prompt 帶入名字、設定、當地時間與內容分級', () => {
    const base = {
      avatar: { name: '小雨', bio: '咖啡店店長', persona: {} },
      history: [
        { senderType: 'avatar' as const, content: '晚安', createdAt: t('2026-10-18T14:00:00Z') },
        { senderType: 'user' as const, content: '早', createdAt: t('2026-10-19T01:00:00Z') },
      ],
      now: t('2026-10-19T01:00:10Z'),
    };
    const sfw = buildSystemPrompt({ ...base, settings: { timezone: 'Asia/Taipei', adultContent: false } });
    expect(sfw).toContain('你是「小雨」');
    expect(sfw).toContain('咖啡店店長');
    expect(sfw).toContain('09:00'); // UTC 01:00 = 台北 09:00
    expect(sfw).toContain('距離上一則訊息過了 11 小時');
    expect(sfw).toContain('不寫露骨的性內容');
    const nsfw = buildSystemPrompt({ ...base, settings: { timezone: 'Asia/Taipei', adultContent: true } });
    expect(nsfw).toContain('允許成人內容');
  });

  it('formatGap', () => {
    expect(formatGap(5 * 60_000)).toBe('5 分鐘');
    expect(formatGap(3 * 3600_000)).toBe('3 小時');
    expect(formatGap(72 * 3600_000)).toBe('3 天');
  });
});

describe('typingMs', () => {
  it('跟長度成正比，有上下限', () => {
    const mid = () => 0.5;
    expect(typingMs('嗨', mid)).toBe(800);
    expect(typingMs('一二三四五六七八九十一二三四五六七八九十', mid)).toBe(2200);
    expect(typingMs('x'.repeat(500), mid)).toBe(7000);
  });
});
