// Gemini API（generateContent）：https://ai.google.dev/api/generate-content
import { geminiThinkingConfig } from '@acc/shared';
import { partsOf } from '../content.ts';
import { alternate, requestJson, requestSignal, trimSlash } from '../http.ts';
import { LlmError, type ProviderAdapter } from '../types.ts';

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

export const googleAdapter: ProviderAdapter = {
  async complete(llm, req, fetchFn) {
    const p = req.params;
    const body = {
      contents: alternate(req.messages).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: partsOf(m.content).map((part) =>
          part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mime, data: part.data } },
        ),
      })),
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      generationConfig: {
        temperature: p.temperature,
        topP: p.topP,
        maxOutputTokens: p.maxOutputTokens,
        presencePenalty: p.presencePenalty,
        frequencyPenalty: p.frequencyPenalty,
        responseMimeType: req.json ? 'application/json' : undefined,
        thinkingConfig: geminiThinkingConfig(llm.model, p.thinking),
      },
      safetySettings: req.relaxedSafety
        ? SAFETY_CATEGORIES.map((category) => ({ category, threshold: 'BLOCK_NONE' }))
        : undefined,
    };
    const res = await requestJson<GenerateResponse>(
      fetchFn,
      `${trimSlash(llm.baseUrl)}/${modelPath(llm.model)}:generateContent`,
      { headers: llm.apiKey ? { 'x-goog-api-key': llm.apiKey } : {}, body, signal: requestSignal(req) },
    );
    const cand = res.candidates?.[0];
    if (!cand) {
      throw new LlmError(`Gemini 沒有回傳內容${res.promptFeedback?.blockReason ? `（被擋下：${res.promptFeedback.blockReason}）` : ''}`);
    }
    const text = (cand.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('');
    return {
      text,
      usage: {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
      },
      finishReason: cand.finishReason ?? null,
    };
  },

  async listModels(llm, fetchFn) {
    const res = await requestJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>(
      fetchFn,
      `${trimSlash(llm.baseUrl)}/models?pageSize=1000`,
      { headers: llm.apiKey ? { 'x-goog-api-key': llm.apiKey } : {} },
    );
    return (res.models ?? []).map((m) => ({ name: m.name.replace(/^models\//, ''), methods: m.supportedGenerationMethods }));
  },
};
