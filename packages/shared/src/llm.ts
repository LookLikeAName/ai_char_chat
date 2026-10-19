// LLM 設定分兩層：
// - LLM 設定檔（profile）：在設定頁統一管理，包含供應商、端點、API key、模型與參數預設值。
// - 綁定（binding）：avatar 或系統工具模型選一個設定檔，只覆寫需要調整的參數。
import { z } from 'zod';

export const PROVIDER_TYPES = ['google', 'anthropic', 'openai', 'openai-compatible'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  google: 'Google Gemini',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI 相容端點',
};

export const DEFAULT_BASE_URLS: Record<ProviderType, string | null> = {
  google: 'https://generativelanguage.googleapis.com/v1beta',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  // OpenRouter、DeepSeek、Ollama、LM Studio… 各自不同，必須填
  'openai-compatible': null,
};

/** 所有參數都可省略：設定檔沒填就用供應商預設，綁定沒填就沿用設定檔。 */
export const llmParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1),
    maxOutputTokens: z.number().int().min(1).max(65536),
    presencePenalty: z.number().min(-2).max(2),
    frequencyPenalty: z.number().min(-2).max(2),
  })
  .partial();
export type LlmParams = z.infer<typeof llmParamsSchema>;
export type LlmParamKey = keyof LlmParams;

export interface ParamSpec {
  key: LlmParamKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 不支援的供應商會在呼叫時略過這個參數 */
  providers: readonly ProviderType[];
}

export const PARAM_SPECS: readonly ParamSpec[] = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05, providers: PROVIDER_TYPES },
  { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.01, providers: PROVIDER_TYPES },
  { key: 'maxOutputTokens', label: '最大輸出 tokens', min: 1, max: 65536, step: 1, providers: PROVIDER_TYPES },
  {
    key: 'presencePenalty',
    label: 'Presence penalty',
    min: -2,
    max: 2,
    step: 0.1,
    providers: ['google', 'openai', 'openai-compatible'],
  },
  {
    key: 'frequencyPenalty',
    label: 'Frequency penalty',
    min: -2,
    max: 2,
    step: 0.1,
    providers: ['google', 'openai', 'openai-compatible'],
  },
];

/** 價格（美元／每 100 萬 tokens），用來估算費用；不填就不算 */
export const llmPricingSchema = z.object({
  input: z.number().min(0).max(10000),
  output: z.number().min(0).max(10000),
});
export type LlmPricing = z.infer<typeof llmPricingSchema>;

export function costUsd(pricing: LlmPricing | null | undefined, inputTokens: number, outputTokens: number): number {
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export const llmProfileInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    provider: z.enum(PROVIDER_TYPES),
    baseUrl: z.string().trim().url().nullable().optional(),
    model: z.string().trim().min(1).max(200),
    /** 只寫不讀：undefined 表示不變更，null 表示清除 */
    apiKey: z.string().trim().min(1).nullable().optional(),
    defaults: llmParamsSchema.default({}),
    pricing: llmPricingSchema.nullable().default(null),
  })
  .refine((p) => p.provider !== 'openai-compatible' || !!p.baseUrl, {
    message: 'OpenAI 相容端點必須填寫 Base URL',
    path: ['baseUrl'],
  });
export type LlmProfileInput = z.infer<typeof llmProfileInputSchema>;

/** 回給前端的設定檔：不含 API key 本身 */
export interface LlmProfileDto {
  id: string;
  name: string;
  provider: ProviderType;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  /** 例如 "…a1b2"，讓使用者分辨是哪一把 key */
  apiKeyHint: string | null;
  defaults: LlmParams;
  pricing: LlmPricing | null;
  /** 綁定這個設定檔的 avatar 數量 */
  usedBy: number;
  createdAt: string;
  updatedAt: string;
}

export const llmBindingSchema = z.object({
  profileId: z.uuid(),
  params: llmParamsSchema.default({}),
});
export type LlmBinding = z.infer<typeof llmBindingSchema>;

/** 設定檔預設值 + 綁定的覆寫值 = 實際使用的參數 */
export function resolveParams(defaults: LlmParams, overrides: LlmParams = {}): LlmParams {
  const out: LlmParams = { ...defaults };
  for (const [k, v] of Object.entries(overrides) as [LlmParamKey, number | undefined][]) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export function effectiveBaseUrl(provider: ProviderType, baseUrl: string | null | undefined): string | null {
  return baseUrl || DEFAULT_BASE_URLS[provider];
}
