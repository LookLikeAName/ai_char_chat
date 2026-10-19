import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_TEST,
  BIG_FIVE_TEST,
  cleanAnswers,
  preferencesSchema,
  progress,
  scoreAttachment,
  scoreBigFive,
  scoreValues,
  VALUES_TEST,
  type Answers,
  type Instrument,
} from './assessment.ts';
import { BIG_FIVE, SCHWARTZ_VALUES } from './persona.ts';

const all = (inst: Instrument, f: (id: string, dim: string, reverse: boolean) => number): Answers =>
  Object.fromEntries(inst.items.map((i) => [i.id, f(i.id, i.dim, !!i.reverse)]));

describe('題庫', () => {
  it('題數與每個向度的題數符合原始量表', () => {
    expect(BIG_FIVE_TEST.items).toHaveLength(20);
    for (const t of BIG_FIVE) expect(BIG_FIVE_TEST.items.filter((i) => i.dim === t)).toHaveLength(4);
    expect(ATTACHMENT_TEST.items).toHaveLength(9);
    expect(ATTACHMENT_TEST.items.filter((i) => i.dim === 'avoidance')).toHaveLength(6);
    expect(VALUES_TEST.items).toHaveLength(21);
    for (const v of SCHWARTZ_VALUES) {
      expect(VALUES_TEST.items.filter((i) => i.dim === v)).toHaveLength(v === 'universalism' ? 3 : 2);
    }
    for (const inst of [BIG_FIVE_TEST, ATTACHMENT_TEST, VALUES_TEST]) {
      expect(inst.scale.labels).toHaveLength(inst.scale.max - inst.scale.min + 1);
      expect(new Set(inst.items.map((i) => i.id)).size).toBe(inst.items.length);
    }
  });
});

describe('五大人格計分', () => {
  it('沒答完不計分', () => {
    expect(scoreBigFive({ ipip1: 5 })).toBeNull();
  });
  it('反向題反轉後取平均，換算 0～100', () => {
    // 每題都選「最像高分端」：正向題 5、反向題 1
    const high = scoreBigFive(all(BIG_FIVE_TEST, (_id, _d, rev) => (rev ? 1 : 5)))!;
    expect(high.scores).toEqual({ openness: 100, conscientiousness: 100, extraversion: 100, agreeableness: 100, neuroticism: 100 });
    // 全部選 3（中點）→ 50
    expect(scoreBigFive(all(BIG_FIVE_TEST, () => 3))!.scores.extraversion).toBe(50);
    // 外向：1、11 選 5；6、16（反向）選 2 → (5+5+4+4)/4 = 4.5 → 88
    const ans = all(BIG_FIVE_TEST, () => 3);
    Object.assign(ans, { ipip1: 5, ipip11: 5, ipip6: 2, ipip16: 2 });
    const r = scoreBigFive(ans)!;
    expect(r.means.extraversion).toBe(4.5);
    expect(r.scores.extraversion).toBe(88);
  });
});

describe('依附計分', () => {
  it('逃避的前四題反向計分，以中點分類', () => {
    const secure = scoreAttachment(
      all(ATTACHMENT_TEST, (_id, dim, rev) => (dim === 'anxiety' ? 2 : rev ? 6 : 2)),
    )!;
    expect(secure).toEqual({ anxiety: 2, avoidance: 2, style: 'secure' });
    const fearful = scoreAttachment(all(ATTACHMENT_TEST, (_id, dim, rev) => (dim === 'anxiety' ? 6 : rev ? 2 : 6)))!;
    expect(fearful.style).toBe('fearful');
    const anxious = scoreAttachment(all(ATTACHMENT_TEST, (_id, dim, rev) => (dim === 'anxiety' ? 7 : rev ? 7 : 1)))!;
    expect(anxious).toMatchObject({ anxiety: 7, avoidance: 1, style: 'anxious' });
  });
});

describe('價值觀計分', () => {
  it('扣掉個人平均後排序', () => {
    const ans = all(VALUES_TEST, (_id, dim) => (dim === 'benevolence' ? 6 : dim === 'power' ? 1 : 4));
    const r = scoreValues(ans)!;
    expect(r.ranking[0]).toBe('benevolence');
    expect(r.ranking.at(-1)).toBe('power');
    expect(r.means.benevolence).toBe(6);
    // 平均 = (6*2 + 1*2 + 4*17) / 21 ≈ 3.90
    expect(r.centered.benevolence).toBe(2.1);
    expect(r.ranking).toHaveLength(10);
  });
});

describe('作答清理與進度', () => {
  it('只保留這份量表的題目與範圍內的整數', () => {
    expect(cleanAnswers('bigFive', { ipip1: 5, ipip2: 9, ecr1: 3, ipip3: 2.5, ipip4: 1 })).toEqual({ ipip1: 5, ipip4: 1 });
    expect(progress('attachment', { ecr1: 3 })).toEqual({ answered: 1, total: 9 });
  });
});

describe('偏好問卷', () => {
  it('只有稱呼必填', () => {
    expect(preferencesSchema.safeParse({}).success).toBe(false);
    expect(preferencesSchema.parse({ nickname: '阿明' })).toMatchObject({ nickname: '阿明', interests: [], romance: null });
  });
});
