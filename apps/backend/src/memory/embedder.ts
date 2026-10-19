// 文字嵌入：Gemini（batchEmbedContents）或 OpenAI 相容（/embeddings），一律輸出 768 維並正規化。
import type { AppSettings } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { EMBEDDING_DIMS } from '../db/schema.ts';
import { requestJson, trimSlash } from '../llm/http.ts';
import { LlmError, type FetchFn, type ResolvedLlm } from '../llm/index.ts';
import { getProfile, resolveRow } from '../services/llmProfiles.ts';

export interface Embedder {
  readonly model: string;
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>;
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n ? v.map((x) => x / n) : v;
}

export class ApiEmbedder implements Embedder {
  constructor(
    private readonly llm: ResolvedLlm,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get model(): string {
    return this.llm.model;
  }

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    if (!texts.length) return [];
    const base = trimSlash(this.llm.baseUrl);
    let vectors: number[][];
    if (this.llm.provider === 'google') {
      const model = this.llm.model.startsWith('models/') ? this.llm.model : `models/${this.llm.model}`;
      const res = await requestJson<{ embeddings?: { values: number[] }[] }>(this.fetchFn, `${base}/${model}:batchEmbedContents`, {
        headers: this.llm.apiKey ? { 'x-goog-api-key': this.llm.apiKey } : {},
        body: {
          requests: texts.map((text) => ({
            model,
            content: { parts: [{ text }] },
            taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            outputDimensionality: EMBEDDING_DIMS,
          })),
        },
      });
      vectors = (res.embeddings ?? []).map((e) => e.values);
    } else if (this.llm.provider === 'openai' || this.llm.provider === 'openai-compatible') {
      const res = await requestJson<{ data?: { index: number; embedding: number[] }[] }>(this.fetchFn, `${base}/embeddings`, {
        headers: this.llm.apiKey ? { authorization: `Bearer ${this.llm.apiKey}` } : {},
        body: { model: this.llm.model, input: texts, dimensions: EMBEDDING_DIMS },
      });
      vectors = (res.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } else {
      throw new LlmError('這個供應商不支援嵌入；請選 Google 或 OpenAI（相容）的設定檔');
    }
    if (vectors.length !== texts.length) throw new LlmError('嵌入結果的數量不符');
    for (const v of vectors) {
      if (v.length !== EMBEDDING_DIMS) throw new LlmError(`嵌入維度是 ${v.length}，需要 ${EMBEDDING_DIMS}（請換支援指定維度的模型）`);
    }
    // 降維後的 Gemini 向量沒有正規化，統一處理
    return vectors.map(normalize);
  }
}

/** 依設定建立嵌入器；沒有設定時回傳 null（記憶改用關鍵字與時間檢索） */
export async function embedderFromSettings(
  db: Db,
  box: SecretBox,
  settings: AppSettings,
  fetchFn?: FetchFn,
): Promise<Embedder | null> {
  if (!settings.embedding) return null;
  const profile = await getProfile(db, settings.embedding.profileId);
  return new ApiEmbedder({ ...resolveRow(profile, box), model: settings.embedding.model }, fetchFn);
}
