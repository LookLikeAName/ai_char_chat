import type { ProfileKind, ProviderType } from '@acc/shared';
import { anthropicAdapter } from './providers/anthropic.ts';
import { googleAdapter } from './providers/google.ts';
import { openaiAdapter } from './providers/openai.ts';
import type { ChatRequest, ChatResult, FetchFn, ListedModel, ProviderAdapter, ResolvedLlm } from './types.ts';

const ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  google: googleAdapter,
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  'openai-compatible': openaiAdapter,
};

export function complete(llm: ResolvedLlm, req: ChatRequest, fetchFn: FetchFn = fetch): Promise<ChatResult> {
  return ADAPTERS[llm.provider].complete(llm, req, fetchFn);
}

/** 列出模型；給了用途時只列這個用途的（例如記憶嵌入只列嵌入模型），篩不出來就全部列 */
export async function listModels(llm: ResolvedLlm, fetchFn: FetchFn = fetch, kind: ProfileKind = 'chat'): Promise<string[]> {
  const models = await ADAPTERS[llm.provider].listModels(llm, fetchFn);
  const fits = models.filter((m) => modelFitsKind(m, kind));
  return (fits.length ? fits : models).map((m) => m.name);
}

function modelFitsKind(m: ListedModel, kind: ProfileKind): boolean {
  const name = m.name.toLowerCase();
  const isEmbedding = /embed/.test(name) || m.methods?.includes('embedContent');
  const isImage = /image|imagen|dall-e/.test(name);
  if (kind === 'embedding') return !!isEmbedding;
  if (kind === 'image') return isImage;
  return !isEmbedding && !isImage && (!m.methods || m.methods.includes('generateContent'));
}

export * from './types.ts';
