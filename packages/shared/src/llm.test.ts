import { describe, expect, it } from 'vitest';
import { geminiThinkingConfig, llmParamsSchema, llmProfileInputSchema, resolveParams } from './llm.ts';
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

describe('geminiThinkingConfig', () => {
  it('Gemini 3 以後用 thinkingLevel；auto 不送，讓模型用預設', () => {
    expect(geminiThinkingConfig('gemini-3-flash-preview', 'minimal')).toEqual({ thinkingLevel: 'minimal' });
    expect(geminiThinkingConfig('models/gemini-3.5-flash', 'medium')).toEqual({ thinkingLevel: 'medium' });
    expect(geminiThinkingConfig('gemini-3-flash', 'auto')).toBeUndefined();
  });
  it('Gemini 3 Pro 只有 low、high', () => {
    expect(geminiThinkingConfig('gemini-3-pro-preview', 'minimal')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('gemini-3-pro-preview', 'medium')).toEqual({ thinkingLevel: 'high' });
  });
  it('Gemini 2.5 用 thinkingBudget；Flash 可以關掉，Pro 最少 128', () => {
    expect(geminiThinkingConfig('gemini-2.5-flash', 'minimal')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-flash-lite', 'high')).toEqual({ thinkingBudget: 24576 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'minimal')).toEqual({ thinkingBudget: 128 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'auto')).toEqual({ thinkingBudget: -1 });
  });
  it('不支援思考的模型、沒設定時不送', () => {
    expect(geminiThinkingConfig('gemini-2.0-flash', 'high')).toBeUndefined();
    expect(geminiThinkingConfig('gemma-3-27b-it', 'high')).toBeUndefined();
    expect(geminiThinkingConfig('gemini-2.5-flash', undefined)).toBeUndefined();
  });
  it('思考程度跟其他參數一樣可以被綁定覆寫', () => {
    expect(llmParamsSchema.parse({ thinking: 'low' })).toEqual({ thinking: 'low' });
    expect(llmParamsSchema.safeParse({ thinking: 'max' }).success).toBe(false);
    expect(resolveParams({ thinking: 'high', temperature: 1 }, { thinking: 'minimal' })).toEqual({ thinking: 'minimal', temperature: 1 });
  });
});
