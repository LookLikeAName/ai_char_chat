// 記憶的寫入與檢索。
// 檢索分數（參考 Generative Agents）：相關度 + 新近度 + 重要性。
// 有嵌入時用 pgvector 的餘弦相似度挑候選；沒有嵌入時用字元雙連詞重疊估相關度。
import { and, cosineDistance, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { memories } from '../db/schema.ts';
import type { Embedder } from './embedder.ts';

export type MemoryRow = typeof memories.$inferSelect;

export interface NewMemory {
  avatarId: string;
  kind: 'event' | 'impression';
  content: string;
  importance: number;
  about?: string;
  sourceConversationId?: string | null;
  visibility?: string;
}

const CANDIDATES = 40;
const RECENCY_HALF_LIFE_HOURS = 72;
const WEIGHTS = { relevance: 0.5, recency: 0.25, importance: 0.25 };

export async function addMemories(db: Db, embedder: Embedder | null, items: NewMemory[]): Promise<MemoryRow[]> {
  if (!items.length) return [];
  let vectors: (number[] | null)[] = items.map(() => null);
  if (embedder) {
    try {
      vectors = await embedder.embed(items.map((i) => i.content), 'document');
    } catch (err) {
      // 嵌入失敗不影響寫入；之後的補嵌入會處理
      console.error('[memory] 嵌入失敗：', (err as Error).message);
    }
  }
  return db
    .insert(memories)
    .values(
      items.map((m, i) => ({
        avatarId: m.avatarId,
        kind: m.kind,
        content: m.content,
        importance: Math.max(1, Math.min(10, Math.round(m.importance))),
        about: m.about ?? 'user',
        sourceConversationId: m.sourceConversationId ?? null,
        visibility: m.visibility ?? 'private',
        embedding: vectors[i],
        embeddingModel: vectors[i] ? embedder!.model : null,
      })),
    )
    .returning();
}

/** 補上缺少（或模型不同）的向量，每次最多 batch 筆 */
export async function backfillEmbeddings(db: Db, embedder: Embedder, avatarId: string, batch = 50): Promise<number> {
  const rows = await db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(
      and(
        eq(memories.avatarId, avatarId),
        or(isNull(memories.embeddingModel), ne(memories.embeddingModel, embedder.model)),
      ),
    )
    .limit(batch);
  if (!rows.length) return 0;
  const vectors = await embedder.embed(rows.map((r) => r.content), 'document');
  for (const [i, r] of rows.entries()) {
    await db.update(memories).set({ embedding: vectors[i], embeddingModel: embedder.model }).where(eq(memories.id, r.id));
  }
  return rows.length;
}

/** 字元雙連詞的 Jaccard 相似度（中文沒有空白，用雙連詞比較合理） */
export function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

export interface RetrieveOptions {
  avatarId: string;
  query: string;
  limit?: number;
  now?: Date;
  /** 只取這些可見性的記憶；省略表示全部 */
  visibility?: string[];
  /** 是否更新取用時間（預覽與檢索測試時不更新） */
  touch?: boolean;
}

export interface ScoredMemory extends MemoryRow {
  score: number;
  relevance: number;
  recency: number;
}

export async function retrieveMemories(db: Db, embedder: Embedder | null, opts: RetrieveOptions): Promise<ScoredMemory[]> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 8;
  const base = and(
    eq(memories.avatarId, opts.avatarId),
    eq(memories.kind, 'event'),
    opts.visibility ? inArray(memories.visibility, opts.visibility) : undefined,
  );

  let queryVec: number[] | null = null;
  if (embedder && opts.query.trim()) {
    try {
      queryVec = (await embedder.embed([opts.query], 'query'))[0] ?? null;
    } catch (err) {
      console.error('[memory] 查詢嵌入失敗：', (err as Error).message);
    }
  }

  // 候選：向量最接近的一批 + 最近的一批 + 最重要的一批
  const byId = new Map<string, MemoryRow & { similarity?: number }>();
  if (queryVec && embedder) {
    const distance = cosineDistance(memories.embedding, queryVec);
    const near = await db
      .select({ row: memories, distance })
      .from(memories)
      .where(and(base, eq(memories.embeddingModel, embedder.model)))
      .orderBy(distance)
      .limit(CANDIDATES);
    for (const n of near) byId.set(n.row.id, { ...n.row, similarity: 1 - Number(n.distance) });
  }
  const recent = await db.select().from(memories).where(base).orderBy(desc(memories.createdAt)).limit(CANDIDATES);
  const important = await db
    .select()
    .from(memories)
    .where(base)
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(CANDIDATES / 2);
  for (const r of [...recent, ...important]) if (!byId.has(r.id)) byId.set(r.id, r);

  const scored = [...byId.values()].map((m) => {
    const relevance = m.similarity ?? (opts.query ? Math.min(1, bigramSimilarity(m.content, opts.query) * 3) : 0);
    const hours = (now.getTime() - m.lastAccessedAt.getTime()) / 3_600_000;
    const recency = Math.pow(0.5, Math.max(0, hours) / RECENCY_HALF_LIFE_HOURS);
    const score =
      WEIGHTS.relevance * relevance + WEIGHTS.recency * recency + WEIGHTS.importance * (m.importance / 10);
    const { similarity: _s, ...row } = m;
    return { ...row, score, relevance, recency };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (top.length && opts.touch !== false) {
    await db
      .update(memories)
      .set({ lastAccessedAt: sql`now()` })
      .where(inArray(memories.id, top.map((m) => m.id)));
  }
  return top;
}

/** 最新的一筆印象 */
export async function latestImpression(db: Db, avatarId: string, about = 'user'): Promise<MemoryRow | null> {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.avatarId, avatarId), eq(memories.kind, 'impression'), eq(memories.about, about)))
    .orderBy(desc(memories.createdAt))
    .limit(1);
  return row ?? null;
}
