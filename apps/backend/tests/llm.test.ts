import { describe, expect, it } from 'vitest';
import { complete, listModels, LlmError, type FetchFn } from '../src/llm/index.ts';
import { alternate } from '../src/llm/http.ts';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(response: unknown, status = 200): { fetchFn: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(response), { status });
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

const messages = [{ role: 'user' as const, content: '嗨' }];

describe('alternate', () => {
  it('合併連續同角色訊息，並補上開頭的 user', () => {
    expect(
      alternate([
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'user', content: 'c' },
      ]),
    ).toEqual([
      { role: 'user', content: '（對話開始）' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b\n\nc' },
    ]);
  });
});

describe('Gemini', () => {
  const llm = { provider: 'google' as const, baseUrl: 'https://g.example/v1beta', model: 'gemini-x', apiKey: 'k' };

  it('組出 generateContent 請求並略過 thought', async () => {
    const { fetchFn, calls } = fakeFetch({
      candidates: [{ content: { parts: [{ text: '想…', thought: true }, { text: '你好' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    const res = await complete(
      llm,
      { system: '你是小雨', messages, params: { temperature: 0.8, maxOutputTokens: 100 }, json: true },
      fetchFn,
    );
    expect(res).toEqual({ text: '你好', usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'STOP' });
    const c = calls[0]!;
    expect(c.url).toBe('https://g.example/v1beta/models/gemini-x:generateContent');
    expect(c.headers['x-goog-api-key']).toBe('k');
    expect(c.body.systemInstruction).toEqual({ parts: [{ text: '你是小雨' }] });
    expect(c.body.generationConfig).toMatchObject({
      temperature: 0.8,
      maxOutputTokens: 100,
      responseMimeType: 'application/json',
    });
    // 可以調整的安全過濾一律不擋（不管有沒有開成人內容）
    expect(c.body.safetySettings).toHaveLength(4);
    expect(c.body.safetySettings.every((x: { threshold: string }) => x.threshold === 'BLOCK_NONE')).toBe(true);
  });

  it('被沒辦法關掉的限制擋下時，回報清楚的錯誤', async () => {
    const { fetchFn } = fakeFetch({ candidates: [{ content: { parts: [] }, finishReason: 'PROHIBITED_CONTENT' }] });
    await expect(complete(llm, { messages, params: {} }, fetchFn)).rejects.toThrow('被擋下（PROHIBITED_CONTENT）');
    const ok = fakeFetch({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] });
    await expect(complete(llm, { messages, params: {} }, ok.fetchFn)).resolves.toMatchObject({ text: '' });
  });

  it('思考程度：Gemini 3 送 thinkingLevel、2.5 送 thinkingBudget；其他供應商不送', async () => {
    const { fetchFn, calls } = fakeFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    await complete({ ...llm, model: 'gemini-3-flash-preview' }, { messages, params: { thinking: 'low' } }, fetchFn);
    await complete({ ...llm, model: 'gemini-2.5-flash' }, { messages, params: { thinking: 'minimal' } }, fetchFn);
    await complete(llm, { messages, params: {} }, fetchFn);
    expect(calls[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(calls[1]!.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(calls[2]!.body.generationConfig.thinkingConfig).toBeUndefined();

    const openai = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
    await complete({ provider: 'openai', baseUrl: 'https://o', model: 'gpt-4o' }, { messages, params: { thinking: 'high' } }, openai.fetchFn);
    expect(JSON.stringify(openai.calls[0]!.body)).not.toContain('thinking');
  });

  it('被擋下時回報原因', async () => {
    const { fetchFn } = fakeFetch({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(complete(llm, { messages, params: {} }, fetchFn)).rejects.toThrow(/SAFETY/);
  });

  it('列出支援 generateContent 的模型', async () => {
    const { fetchFn } = fakeFetch({
      models: [
        { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed-b', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
      ],
    });
    expect(await listModels(llm, fetchFn)).toEqual(['gemini-a']);
    expect(await listModels(llm, fetchFn, 'embedding')).toEqual(['embed-b']);
    expect(await listModels(llm, fetchFn, 'image')).toEqual(['gemini-2.5-flash-image', 'imagen-4.0-generate-001']);
  });
});

describe('Anthropic', () => {
  it('組出 Messages 請求，max_tokens 有預設值', async () => {
    const { fetchFn, calls } = fakeFetch({
      content: [{ type: 'text', text: '哈囉' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    const res = await complete(
      { provider: 'anthropic', baseUrl: 'https://a.example', model: 'claude-x', apiKey: 'k' },
      { system: 's', messages, params: { topP: 0.9 } },
      fetchFn,
    );
    expect(res.text).toBe('哈囉');
    const c = calls[0]!;
    expect(c.url).toBe('https://a.example/v1/messages');
    expect(c.headers['x-api-key']).toBe('k');
    expect(c.body).toMatchObject({ model: 'claude-x', max_tokens: 1024, system: 's', top_p: 0.9 });
    expect(c.body.temperature).toBeUndefined();
  });
});

describe('OpenAI 與相容端點', () => {
  const reply = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

  it('官方 API 用 max_completion_tokens', async () => {
    const { fetchFn, calls } = fakeFetch(reply);
    await complete(
      { provider: 'openai', baseUrl: 'https://o.example/v1/', model: 'gpt-x', apiKey: 'k' },
      { system: 's', messages, params: { maxOutputTokens: 50, presencePenalty: 0.5 }, json: true },
      fetchFn,
    );
    const c = calls[0]!;
    expect(c.url).toBe('https://o.example/v1/chat/completions');
    expect(c.headers.authorization).toBe('Bearer k');
    expect(c.body.messages[0]).toEqual({ role: 'system', content: 's' });
    expect(c.body).toMatchObject({ max_completion_tokens: 50, presence_penalty: 0.5, response_format: { type: 'json_object' } });
  });

  it('相容端點用 max_tokens，沒有 key 時不送 authorization', async () => {
    const { fetchFn, calls } = fakeFetch(reply);
    await complete(
      { provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1', model: 'llama' },
      { messages, params: { maxOutputTokens: 50 } },
      fetchFn,
    );
    expect(calls[0]!.body.max_tokens).toBe(50);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('連不上時帶上底層的錯誤代碼', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }) as unknown as FetchFn;
    await expect(
      complete({ provider: 'openai', baseUrl: 'https://o.example/v1', model: 'gpt-x' }, { messages, params: {} }, fetchFn),
    ).rejects.toThrow('無法連線：fetch failed（ENOTFOUND）');
  });

  it('錯誤回應轉成 LlmError 並帶上供應商訊息', async () => {
    const { fetchFn } = fakeFetch({ error: { message: 'Invalid API key' } }, 401);
    const err = await complete(
      { provider: 'openai', baseUrl: 'https://o.example/v1', model: 'gpt-x' },
      { messages, params: {} },
      fetchFn,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('Invalid API key');
  });
});
