import type { LlmParams, MessageContent, ProviderType } from '@acc/shared';

export interface ChatMessage {
  role: 'user' | 'assistant';
  /** 文字，或文字與圖片混合（只有看得懂圖片的模型才會收到圖片） */
  content: MessageContent;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  params: LlmParams;
  /** 要求輸出 JSON；不支援的供應商只靠 prompt */
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string | null;
}

/** 已解出 API key、可以直接呼叫的設定 */
export interface ResolvedLlm {
  provider: ProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type FetchFn = typeof fetch;

export interface ProviderAdapter {
  complete(llm: ResolvedLlm, req: ChatRequest, fetchFn: FetchFn): Promise<ChatResult>;
  listModels(llm: ResolvedLlm, fetchFn: FetchFn): Promise<ListedModel[]>;
}

/** methods：供應商有提供時（Gemini）列出支援的呼叫方式，例如 generateContent、embedContent */
export interface ListedModel {
  name: string;
  methods?: string[];
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
