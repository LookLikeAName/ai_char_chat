// OpenAI Chat Completions，也涵蓋所有 OpenAI 相容端點（OpenRouter、DeepSeek、Ollama、LM Studio、vLLM…）
import { requestJson, requestSignal, trimSlash } from '../http.ts';
import type { ProviderAdapter, ResolvedLlm } from '../types.ts';

interface CompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function headers(llm: ResolvedLlm): Record<string, string> {
  return llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {};
}

export const openaiAdapter: ProviderAdapter = {
  async complete(llm, req, fetchFn) {
    const p = req.params;
    const official = llm.provider === 'openai';
    const body = {
      model: llm.model,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages],
      temperature: p.temperature,
      top_p: p.topP,
      presence_penalty: p.presencePenalty,
      frequency_penalty: p.frequencyPenalty,
      // OpenAI 官方的新模型只接受 max_completion_tokens；相容端點大多仍用 max_tokens
      ...(official ? { max_completion_tokens: p.maxOutputTokens } : { max_tokens: p.maxOutputTokens }),
      response_format: req.json ? { type: 'json_object' } : undefined,
    };
    const res = await requestJson<CompletionResponse>(fetchFn, `${trimSlash(llm.baseUrl)}/chat/completions`, {
      headers: headers(llm),
      body,
      signal: requestSignal(req),
    });
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
    return (res.data ?? []).map((m) => m.id).sort();
  },
};
