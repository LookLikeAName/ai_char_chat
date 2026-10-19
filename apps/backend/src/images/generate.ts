// 頭像生成。依設定檔的供應商與模型名稱選擇 API：
// - Google + imagen-*：Imagen（:predict）
// - Google + 其他（例如 gemini-*-image）：Gemini 原生圖片輸出（generateContent）
// - OpenAI／OpenAI 相容：/images/generations
import { requestJson, trimSlash } from '../llm/http.ts';
import { LlmError, type FetchFn, type ResolvedLlm } from '../llm/index.ts';

export interface GeneratedImage {
  data: Buffer;
  mime: string;
}

const TIMEOUT_MS = 120_000;

function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

export async function generateImage(llm: ResolvedLlm, prompt: string, fetchFn: FetchFn = fetch): Promise<GeneratedImage> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const base = trimSlash(llm.baseUrl);

  if (llm.provider === 'google') {
    const headers: Record<string, string> = llm.apiKey ? { 'x-goog-api-key': llm.apiKey } : {};
    if (/^(models\/)?imagen/.test(llm.model)) {
      const res = await requestJson<{ predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] }>(
        fetchFn,
        `${base}/${modelPath(llm.model)}:predict`,
        { headers, body: { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } }, signal },
      );
      const p = res.predictions?.[0];
      if (!p?.bytesBase64Encoded) throw new LlmError('Imagen 沒有回傳圖片（可能被安全過濾擋下）');
      return { data: Buffer.from(p.bytesBase64Encoded, 'base64'), mime: p.mimeType ?? 'image/png' };
    }
    const res = await requestJson<{
      candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    }>(fetchFn, `${base}/${modelPath(llm.model)}:generateContent`, {
      headers,
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
      },
      signal,
    });
    const part = res.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data);
    if (!part?.inlineData?.data) {
      const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason;
      throw new LlmError(`模型沒有回傳圖片${why ? `（${why}）` : ''}；請確認選的是支援圖片輸出的模型`);
    }
    return { data: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType ?? 'image/png' };
  }

  if (llm.provider === 'openai' || llm.provider === 'openai-compatible') {
    const res = await requestJson<{ data?: { b64_json?: string; url?: string }[] }>(fetchFn, `${base}/images/generations`, {
      headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {},
      body: {
        model: llm.model,
        prompt,
        n: 1,
        size: '1024x1024',
        // dall-e 預設回網址；gpt-image 系列只回 base64
        ...(/^dall-e/.test(llm.model) ? { response_format: 'b64_json' } : {}),
      },
      signal,
    });
    const d = res.data?.[0];
    if (d?.b64_json) return { data: Buffer.from(d.b64_json, 'base64'), mime: 'image/png' };
    if (d?.url) {
      const img = await fetchFn(d.url, { signal });
      if (!img.ok) throw new LlmError(`無法下載生成的圖片：HTTP ${img.status}`);
      return { data: Buffer.from(await img.arrayBuffer()), mime: img.headers.get('content-type') ?? 'image/png' };
    }
    throw new LlmError('沒有回傳圖片');
  }

  throw new LlmError('這個供應商不支援圖片生成；請選 Google 或 OpenAI（相容）的設定檔');
}
