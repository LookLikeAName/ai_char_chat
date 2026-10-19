// 圖片：格式判斷、送給各家模型的格式、對話紀錄裡的圖片、avatar 的照片輸出與描述
import { describe, expect, it } from 'vitest';
import { inspectImage } from '../src/images/inspect.ts';
import { complete, type FetchFn } from '../src/llm/index.ts';
import { loggedContent } from '../src/llm/content.ts';
import { parseReplyOutput } from '../src/reply/output.ts';
import { buildHistory, buildSystemPrompt, type HistoryImages, type HistoryMessage, type PromptGroup } from '../src/reply/prompt.ts';
import { photoPrompt } from '../src/services/photos.ts';
import { fakePng } from './fixtures/images.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

describe('inspectImage', () => {
  it('從內容判斷格式與尺寸，不看副檔名', () => {
    expect(inspectImage(fakePng(640, 480))).toEqual({ mime: 'image/png', ext: 'png', width: 640, height: 480 });
    const gif = Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1');
    expect(inspectImage(gif)).toMatchObject({ mime: 'image/gif', width: 800, height: 600 });
    // JPEG：SOI、APP0（長度 16）、SOF0（高 300、寬 400）
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03]),
    ]);
    expect(inspectImage(jpeg)).toMatchObject({ mime: 'image/jpeg', ext: 'jpg', width: 400, height: 300 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(1023, 24, 3);
    webp.writeUIntLE(767, 27, 3);
    expect(inspectImage(webp)).toMatchObject({ mime: 'image/webp', width: 1024, height: 768 });
    expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('送給模型的圖片格式', () => {
  const img = { type: 'image' as const, mime: 'image/png', data: 'QUJD' };
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '你看' }, img] }];
  const capture = () => {
    const bodies: any[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          content: [{ type: 'text', text: 'ok' }],
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        }),
      );
    }) as unknown as FetchFn;
    return { bodies, fetchFn };
  };

  it('Gemini：inlineData', async () => {
    const { bodies, fetchFn } = capture();
    await complete({ provider: 'google', baseUrl: 'http://g', model: 'm' }, { messages, params: {} }, fetchFn);
    expect(bodies[0].contents[0].parts).toEqual([{ text: '你看' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }]);
  });

  it('Anthropic：base64 image block', async () => {
    const { bodies, fetchFn } = capture();
    await complete({ provider: 'anthropic', baseUrl: 'http://a', model: 'm' }, { messages, params: {} }, fetchFn);
    expect(bodies[0].messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  });

  it('OpenAI（相容）：data URL；純文字維持字串', async () => {
    const { bodies, fetchFn } = capture();
    await complete({ provider: 'openai', baseUrl: 'http://o', model: 'm' }, { messages, params: {} }, fetchFn);
    expect(bodies[0].messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    await complete({ provider: 'openai-compatible', baseUrl: 'http://o', model: 'm' }, { messages: [{ role: 'user', content: '嗨' }], params: {} }, fetchFn);
    expect(bodies[1].messages[0].content).toBe('嗨');
  });

  it('監控紀錄不存整張圖', () => {
    expect(loggedContent(messages[0]!.content)).toEqual([{ type: 'text', text: '你看' }, { type: 'image', mime: 'image/png', bytes: 3 }]);
  });
});

describe('對話紀錄裡的圖片', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 9, 19, 10, min));

  it('附上的圖片放在提到它的那一行後面；沒附上的用描述；看不到也會說', () => {
    const shown: HistoryMessage = { senderType: 'user', content: '這是我家的貓', createdAt: t(2), image: {} };
    const history: HistoryMessage[] = [
      { senderType: 'user', content: '', createdAt: t(0), image: { caption: '一盤滷肉飯' } },
      { senderType: 'user', content: '', createdAt: t(1), image: {} },
      shown,
    ];
    const images: HistoryImages = new Map([[shown, { mime: 'image/jpeg', data: 'Q0FU' }]]);
    const [msg] = buildHistory(history, null, images);
    expect(msg).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '［傳了一張圖片：一盤滷肉飯］\n［傳了一張圖片，但你看不到內容］\n［傳了一張圖片，見下圖］ 這是我家的貓' },
        { type: 'image', mime: 'image/jpeg', data: 'Q0FU' },
      ],
    });
    // 沒有附上任何圖片時維持純文字
    expect(typeof buildHistory(history.slice(0, 2))[0]!.content).toBe('string');
  });

  it('自己傳過的照片用 photo 欄位表示；群組裡別人的照片寫出內容', () => {
    const group: PromptGroup = {
      conversationId: 'g',
      title: '週末團',
      selfId: 'me',
      members: [{ id: 'zhe', name: '阿哲', bio: '' }],
      userName: '阿明',
      discretion: 50,
    };
    const out = buildHistory(
      [
        { senderType: 'user', content: '晚餐吃什麼', createdAt: t(0) },
        { senderType: 'avatar', senderAvatarId: 'me', content: '你看', createdAt: t(1) },
        { senderType: 'avatar', senderAvatarId: 'me', content: '', createdAt: t(1), image: { description: '桌上的拉麵' } },
        { senderType: 'avatar', senderAvatarId: 'zhe', content: '', createdAt: t(2), image: { description: '一碗牛肉麵' } },
      ],
      group,
    );
    expect(JSON.parse(out[1]!.content as string)).toEqual({ messages: ['你看'], photo: '桌上的拉麵' });
    expect(out[2]!.content).toBe('阿哲：［傳了一張照片：一碗牛肉麵］');
  });
});

describe('avatar 的照片', () => {
  it('輸出可以只有照片', () => {
    expect(parseReplyOutput('{"messages": [], "photo": "  剛煮好的咖啡  "}')).toMatchObject({ messages: [], photo: '剛煮好的咖啡' });
    expect(parseReplyOutput('{"messages": ["嗨"]}')!.photo).toBeNull();
    expect(parseReplyOutput('{"messages": []}')).toBeNull();
  });

  it('可以傳照片時 prompt 說明怎麼傳、還剩幾張；用完時叫它不要傳', () => {
    const base = {
      avatar: { name: '小雨', bio: '', persona: SAMPLE_PERSONA },
      user: null,
      situation: { mode: 'reply' as const, reason: 'normal' as const },
      settings: { timezone: 'Asia/Taipei', adultContent: false },
      history: [],
      now: new Date('2026-10-19T10:00:00Z'),
      state: { relationship: { stage: 'friend' as const, affinity: 30, trust: 30 }, mood: { label: '平常', valence: 0, energy: 0 }, memories: [], impression: null },
    };
    expect(buildSystemPrompt({ ...base, photos: { remaining: 3 } })).toContain('今天最多還能傳 3 張');
    expect(buildSystemPrompt({ ...base, photos: { remaining: 0 } })).toContain('這次不要再傳');
    expect(buildSystemPrompt(base)).not.toContain('photo');
  });

  it('照片的 prompt 帶上外貌；有參考圖時要求長得一樣', () => {
    const p = photoPrompt({ name: '小雨', persona: SAMPLE_PERSONA }, '在吧檯後面比耶的自拍', { style: 'realistic', adult: false, hasReference: true });
    expect(p).toContain('畫面：在吧檯後面比耶的自拍');
    expect(p).toContain('短髮染成深棕色');
    expect(p).toContain('參考圖');
    expect(p).toContain('非裸露');
  });
});
