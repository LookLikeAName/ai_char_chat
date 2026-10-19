import type { Embedder } from '../../src/memory/embedder.ts';

/** 可重現的假嵌入：把字元雙連詞雜湊到 768 維，文字越像向量越接近 */
export class FakeEmbedder implements Embedder {
  calls: string[][] = [];
  constructor(readonly model = 'fake-embed') {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = new Array(768).fill(0);
      const s = t.replace(/\s+/g, '');
      for (let i = 0; i < s.length - 1; i++) {
        let h = 0;
        for (const ch of s.slice(i, i + 2)) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
        v[h % 768] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}
