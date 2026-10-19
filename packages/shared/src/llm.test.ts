import { describe, expect, it } from 'vitest';
import { llmProfileInputSchema, resolveParams } from './llm.ts';
import { appSettingsPatchSchema, appSettingsSchema, isValidTimezone } from './settings.ts';

describe('resolveParams', () => {
  it('綁定的覆寫值優先，沒覆寫的沿用設定檔', () => {
    expect(resolveParams({ temperature: 0.7, maxOutputTokens: 800 }, { temperature: 1.1 })).toEqual({
      temperature: 1.1,
      maxOutputTokens: 800,
    });
  });
  it('覆寫值為 undefined 時不會蓋掉預設值', () => {
    expect(resolveParams({ topP: 0.9 }, { topP: undefined })).toEqual({ topP: 0.9 });
  });
});

describe('llmProfileInputSchema', () => {
  it('OpenAI 相容端點必須有 baseUrl', () => {
    const r = llmProfileInputSchema.safeParse({ name: 'x', provider: 'openai-compatible', model: 'm' });
    expect(r.success).toBe(false);
  });
  it('defaults 省略時為空物件', () => {
    const r = llmProfileInputSchema.parse({ name: 'x', provider: 'google', model: 'gemini' });
    expect(r.defaults).toEqual({});
  });
});

describe('appSettingsSchema', () => {
  it('空物件會補上預設值', () => {
    const s = appSettingsSchema.parse({});
    expect(s.timezone).toBe('Asia/Taipei');
    expect(s.adultContent).toBe(false);
    expect(s.utilityLlm).toBeNull();
  });
  it('部分更新不會補上其他欄位的預設值', () => {
    expect(appSettingsPatchSchema.parse({ timezone: 'Asia/Tokyo' })).toEqual({ timezone: 'Asia/Tokyo' });
  });
  it('檢查時區', () => {
    expect(isValidTimezone('Asia/Taipei')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
  });
});
