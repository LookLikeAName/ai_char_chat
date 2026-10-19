import { describe, expect, it } from 'vitest';
import {
  currentBlock,
  isPersonaEmpty,
  missingFields,
  PERSONA_PATHS,
  PERSONA_SECTIONS,
  personaSchema,
  sanitizeDraft,
  setField,
} from './persona.ts';

describe('persona 定義', () => {
  it('介面的欄位說明和 schema 完全一致', () => {
    for (const section of PERSONA_SECTIONS) {
      const shape = personaSchema.shape[section.key].shape;
      expect(Object.keys(section.fields).sort()).toEqual(Object.keys(shape).sort());
    }
    expect(PERSONA_SECTIONS.map((s) => s.key).sort()).toEqual(Object.keys(personaSchema.shape).sort());
  });

  it('未滿 18 歲不合法', () => {
    const { errors } = sanitizeDraft({ basic: { age: 17 } });
    expect(errors['basic.age']).toContain('18');
  });
});

describe('sanitizeDraft', () => {
  it('保留合法的值、丟掉空值、回報不合法的值', () => {
    const { draft, errors } = sanitizeDraft({
      basic: { age: 27, gender: '', occupation: '  咖啡店店長 ' },
      speech: { emoji: 'tons', catchphrases: ['真假'] },
      unknown: { x: 1 },
    });
    expect(draft).toEqual({ basic: { age: 27, occupation: '咖啡店店長' }, speech: { catchphrases: ['真假'] } });
    expect(Object.keys(errors)).toEqual(['speech.emoji']);
  });

  it('價值排序必須包含 10 個不重複的價值', () => {
    const { errors } = sanitizeDraft({ values: { ranking: ['power', 'power'] } });
    expect(errors['values.ranking']).toBeDefined();
  });
});

describe('完整度', () => {
  it('空的設定缺所有欄位', () => {
    expect(missingFields({})).toEqual(PERSONA_PATHS);
    expect(isPersonaEmpty({})).toBe(true);
    expect(isPersonaEmpty(setField({}, 'basic.age', 30))).toBe(false);
  });
});

describe('currentBlock', () => {
  const schedule = {
    weekday: [
      { start: '23:30', end: '07:30', activity: '睡覺', status: 'sleep' as const },
      { start: '09:00', end: '18:00', activity: '上班', status: 'busy' as const },
      { start: '18:00', end: '23:30', activity: '在家放空', status: 'free' as const },
    ],
    weekend: [{ start: '10:00', end: '02:00', activity: '自由活動', status: 'free' as const }],
  };
  it('一般區段與跨午夜的區段', () => {
    expect(currentBlock(schedule, false, '10:15')?.activity).toBe('上班');
    expect(currentBlock(schedule, false, '02:00')?.activity).toBe('睡覺');
    expect(currentBlock(schedule, false, '23:45')?.activity).toBe('睡覺');
    expect(currentBlock(schedule, false, '08:00')).toBeNull();
    expect(currentBlock(schedule, true, '01:00')?.activity).toBe('自由活動');
  });
});
