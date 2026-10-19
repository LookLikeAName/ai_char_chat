import type { ProviderType } from '@acc/shared';
import { anthropicAdapter } from './providers/anthropic.ts';
import { googleAdapter } from './providers/google.ts';
import { openaiAdapter } from './providers/openai.ts';
import type { ChatRequest, ChatResult, FetchFn, ProviderAdapter, ResolvedLlm } from './types.ts';

const ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  google: googleAdapter,
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  'openai-compatible': openaiAdapter,
};

export function complete(llm: ResolvedLlm, req: ChatRequest, fetchFn: FetchFn = fetch): Promise<ChatResult> {
  return ADAPTERS[llm.provider].complete(llm, req, fetchFn);
}

export function listModels(llm: ResolvedLlm, fetchFn: FetchFn = fetch): Promise<string[]> {
  return ADAPTERS[llm.provider].listModels(llm, fetchFn);
}

export * from './types.ts';
