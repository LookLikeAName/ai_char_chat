// OpenAI Chat Completions，也涵蓋所有 OpenAI 相容端點（OpenRouter、DeepSeek、Ollama、LM Studio、vLLM…）
import { requestJson, requestSignal, trimSlash } from '../http.ts';
import { LlmError, type ChatMessage, type ProviderAdapter, type ResolvedLlm } from '../types.ts';

interface CompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAi(m: ChatMessage) {
  if (typeof m.content === 'string') return m;
  return {
    role: m.role,
    content: m.content.map((p) =>
      p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } },
    ),
  };
}

function headers(llm: ResolvedLlm): Record<string, string> {
  return llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {};
}

/**
 * 要求 JSON 輸出的方式。相容端點支援的不一樣：多數接受 json_object；LM Studio 只接受 json_schema 或 text；
 * 也有完全不支援的。被拒絕（400 且錯誤提到 response_format）就換下一種，試出來的結果依端點＋模型記住。
 */
type JsonMode = 'json_object' | 'json_schema' | 'none';
const JSON_MODES: JsonMode[] = ['json_object', 'json_schema', 'none'];
const jsonModes = new Map<string, JsonMode>();

function responseFormat(mode: JsonMode) {
  if (mode === 'json_object') return { type: 'json_object' };
  // 只要求是一個 JSON 物件，欄位交給 prompt
  if (mode === 'json_schema') return { type: 'json_schema', json_schema: { name: 'output', schema: { type: 'object' } } };
  return undefined;
}

const formatRejected = (err: unknown) =>
  err instanceof LlmError && err.status === 400 && /response_format|json_schema|json_object/i.test(err.message);

/** 測試用：清掉記住的 JSON 模式 */
export function resetJsonModes(): void {
  jsonModes.clear();
}

export const openaiAdapter: ProviderAdapter = {
  async complete(llm, req, fetchFn) {
    const p = req.params;
    const official = llm.provider === 'openai';
    const key = `${trimSlash(llm.baseUrl)}|${llm.model}`;
    const body = (mode: JsonMode) => ({
      model: llm.model,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages.map(toOpenAi)],
      temperature: p.temperature,
      top_p: p.topP,
      presence_penalty: p.presencePenalty,
      frequency_penalty: p.frequencyPenalty,
      // OpenAI 官方的新模型只接受 max_completion_tokens；相容端點大多仍用 max_tokens
      ...(official ? { max_completion_tokens: p.maxOutputTokens } : { max_tokens: p.maxOutputTokens }),
      response_format: req.json ? responseFormat(mode) : undefined,
    });
    const send = (mode: JsonMode) =>
      requestJson<CompletionResponse>(fetchFn, `${trimSlash(llm.baseUrl)}/chat/completions`, {
        headers: headers(llm),
        body: body(mode),
        signal: requestSignal(req),
      });
    let res: CompletionResponse;
    if (!req.json) {
      res = await send('none');
    } else {
      let i = JSON_MODES.indexOf(jsonModes.get(key) ?? 'json_object');
      for (;;) {
        try {
          res = await send(JSON_MODES[i]!);
          break;
        } catch (err) {
          if (!formatRejected(err) || i === JSON_MODES.length - 1) throw err;
          i++;
          jsonModes.set(key, JSON_MODES[i]!);
        }
      }
    }
    const choice = res.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      finishReason: choice?.finish_reason ?? null,
    };
  },

  async listModels(llm, fetchFn) {
    const res = await requestJson<{ data?: { id: string }[] }>(fetchFn, `${trimSlash(llm.baseUrl)}/models`, {
      headers: headers(llm),
    });
    return (res.data ?? []).map((m) => ({ name: m.id })).sort((a, b) => a.name.localeCompare(b.name));
  },
};
