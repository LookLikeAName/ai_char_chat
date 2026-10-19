// Anthropic Messages API：https://docs.anthropic.com/en/api/messages
import { alternate, requestJson, requestSignal, trimSlash } from '../http.ts';
import type { ChatMessage } from '../types.ts';
import type { ProviderAdapter, ResolvedLlm } from '../types.ts';

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const DEFAULT_MAX_TOKENS = 1024;

function toAnthropic(m: ChatMessage) {
  if (typeof m.content === 'string') return m;
  return {
    role: m.role,
    content: m.content.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } },
    ),
  };
}

function headers(llm: ResolvedLlm): Record<string, string> {
  return { 'anthropic-version': '2023-06-01', ...(llm.apiKey ? { 'x-api-key': llm.apiKey } : {}) };
}

export const anthropicAdapter: ProviderAdapter = {
  async complete(llm, req, fetchFn) {
    const p = req.params;
    // 沒有原生 JSON 模式；JSON 輸出靠 prompt 要求，由呼叫端解析與重試
    const body = {
      model: llm.model,
      max_tokens: p.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      system: req.system || undefined,
      messages: alternate(req.messages).map(toAnthropic),
      temperature: p.temperature,
      top_p: p.topP,
    };
    const res = await requestJson<MessagesResponse>(fetchFn, `${trimSlash(llm.baseUrl)}/v1/messages`, {
      headers: headers(llm),
      body,
      signal: requestSignal(req),
    });
    return {
      text: (res.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join(''),
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      finishReason: res.stop_reason ?? null,
    };
  },

  async listModels(llm, fetchFn) {
    const res = await requestJson<{ data?: { id: string }[] }>(fetchFn, `${trimSlash(llm.baseUrl)}/v1/models?limit=1000`, {
      headers: headers(llm),
    });
    return (res.data ?? []).map((m) => m.id);
  },
};
