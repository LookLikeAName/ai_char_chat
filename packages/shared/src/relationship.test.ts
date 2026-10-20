import { describe, expect, it } from 'vitest';
import { applyDeltas, canBecomeLovers, decayMood, nextStage, romanceGuidance, romanceOpen } from './relationship.ts';

describe('nextStage：友誼的階梯', () => {
  it('依門檻升階', () => {
    expect(nextStage('stranger', 5, 10)).toBe('stranger');
    expect(nextStage('stranger', 12, 10)).toBe('acquaintance');
    expect(nextStage('acquaintance', 31, 26)).toBe('friend');
    expect(nextStage('friend', 56, 51)).toBe('close');
  });
  it('信任不夠就不會升階', () => {
    expect(nextStage('acquaintance', 40, 10)).toBe('acquaintance');
  });
  it('降階有緩衝，且認識後不會回到陌生', () => {
    expect(nextStage('friend', 25, 20)).toBe('friend');
    expect(nextStage('friend', 18, 20)).toBe('acquaintance');
    expect(nextStage('acquaintance', 0, 0)).toBe('acquaintance');
  });
  it('好感太低變冷淡或疏遠，回升後恢復', () => {
    expect(nextStage('friend', -25, 20)).toBe('cold');
    expect(nextStage('cold', -55, 0)).toBe('estranged');
    expect(nextStage('cold', -5, 0)).toBe('cold');
    expect(nextStage('cold', 12, 10)).toBe('acquaintance');
  });
});

describe('nextStage：友誼的階梯延伸到摯友', () => {
  it('好感與信任都很高 → 摯友；稍微下滑不會馬上掉', () => {
    expect(nextStage('close', 76, 71)).toBe('bestie');
    expect(nextStage('bestie', 68, 62)).toBe('bestie');
    expect(nextStage('bestie', 60, 55)).toBe('close');
  });
});

describe('nextStage：戀愛需要事件 + 數值（含心動）', () => {
  it('數值不夠時告白事件不會升級；心動不夠也不行', () => {
    expect(nextStage('friend', 40, 30, 'confession_accepted', 80)).toBe('friend');
    expect(nextStage('close', 62, 50, 'confession_accepted', 30)).toBe('close');
  });
  it('好友、摯友或曖昧、數值夠時接受告白 → 戀人', () => {
    expect(nextStage('close', 62, 50, 'confession_accepted', 60)).toBe('lover');
    expect(nextStage('bestie', 80, 75, 'confession_accepted', 60)).toBe('lover');
    expect(nextStage('crush', 61, 46, 'confession_accepted', 56)).toBe('lover');
  });
  it('朋友以上、好感與心動夠 → 曖昧', () => {
    expect(nextStage('friend', 46, 31, 'mutual_feelings', 40)).toBe('crush');
    expect(nextStage('friend', 46, 31, 'mutual_feelings', 10)).toBe('friend');
    expect(nextStage('acquaintance', 46, 31, 'mutual_feelings', 40)).toBe('friend');
  });
  it('曖昧被拒絕 → 回到朋友的階梯', () => {
    expect(nextStage('crush', 50, 35, 'confession_rejected', 40)).toBe('friend');
    expect(nextStage('crush', 60, 52, 'confession_rejected', 40)).toBe('close');
  });
  it('戀人不會因小波動降級；分手 → 前任', () => {
    expect(nextStage('lover', 30, 40)).toBe('lover');
    expect(nextStage('lover', 40, 40, 'breakup')).toBe('ex');
    expect(nextStage('crush', 40, 40, 'breakup')).toBe('friend');
    expect(nextStage('lover', 5, 40)).toBe('cold');
  });
  it('前任：不會自己變回朋友；復合或放下才會改變', () => {
    expect(nextStage('ex', 60, 60)).toBe('ex');
    expect(nextStage('ex', 50, 40, 'got_back_together', 60)).toBe('lover');
    expect(nextStage('ex', 50, 40, 'got_back_together', 40)).toBe('crush');
    expect(nextStage('ex', 20, 20, 'got_back_together', 60)).toBe('ex');
    expect(nextStage('ex', 35, 30, 'moved_on')).toBe('friend');
    expect(nextStage('ex', -30, 30)).toBe('cold');
  });
});

describe('applyDeltas', () => {
  it('每次最多 ±3，慢熱的人好感漲得比較慢', () => {
    const s = { stage: 'acquaintance' as const, affinity: 20, trust: 20 };
    expect(applyDeltas(s, { affinity: 10, trust: -9 })).toMatchObject({ affinity: 23, trust: 17 });
    expect(applyDeltas(s, { affinity: 3 }, 'slow').affinity).toBe(22);
    expect(applyDeltas(s, { affinity: 3 }, 'fast').affinity).toBe(24);
    expect(applyDeltas(s, { affinity: -3 }, 'slow').affinity).toBe(17);
  });
  it('事件帶來額外的變化並改變階段（心動也算）', () => {
    const s = { stage: 'close' as const, affinity: 58, trust: 50, romance: 50 };
    expect(canBecomeLovers(s)).toBe(false);
    const r = applyDeltas(s, { affinity: 2, romance: 1, event: 'confession_accepted' });
    // 好感 58 + 2 + 5 = 65、心動 50 + 1 + 8 = 59 → 符合門檻
    expect(r).toEqual({ affinity: 65, trust: 55, romance: 59, stage: 'lover' });
  });
  it('沒有追蹤心動的對象（avatar 之間）不會多出心動', () => {
    expect(applyDeltas({ stage: 'friend', affinity: 40, trust: 40 }, { romance: 3 })).not.toHaveProperty('romance');
  });
  it('心動不會比好感高太多；放下之後只留一點', () => {
    expect(applyDeltas({ stage: 'friend', affinity: 10, trust: 30, romance: 30 }, { romance: 3 }).romance).toBe(30);
    expect(applyDeltas({ stage: 'ex', affinity: 40, trust: 40, romance: 50 }, { event: 'moved_on' })).toMatchObject({ romance: 15, stage: 'friend' });
  });
});

describe('romanceOpen：數值夠才把戀愛的部分放給 LLM', () => {
  it('只想當朋友、陌生、交惡、或還沒什麼好感時不開放', () => {
    const friend = { stage: 'friend' as const, affinity: 30, trust: 30, romance: 0 };
    expect(romanceOpen(friend, 'open')).toBe(true);
    expect(romanceOpen(friend, 'none')).toBe(false);
    expect(romanceOpen({ ...friend, affinity: 10 }, 'open')).toBe(false);
    expect(romanceOpen({ ...friend, stage: 'stranger' }, 'open')).toBe(false);
    expect(romanceOpen({ ...friend, stage: 'cold' }, 'open')).toBe(false);
    expect(romanceOpen({ ...friend, stage: 'ex', affinity: 5 }, null)).toBe(true);
    expect(romanceOpen({ stage: 'friend', affinity: 50, trust: 50 }, 'open')).toBe(false);
  });
});

describe('romanceGuidance：依心動的層級逐步放出', () => {
  const at = (s: object) => romanceGuidance({ stage: 'friend', affinity: 50, trust: 40, romance: 0, ...s }).join('\n');
  it('心動低時只有「太突然」', () => {
    expect(at({ romance: 5 })).toContain('太突然');
    expect(at({ romance: 5 })).not.toContain('喜歡上對方');
  });
  it('在意 → 喜歡（可以回報彼此有好感）', () => {
    expect(at({ romance: 20 })).toContain('開始有點在意');
    expect(at({ romance: 40 })).toContain('喜歡上對方了');
    expect(at({ romance: 40 })).toContain('mutual_feelings');
  });
  it('曖昧、數值夠：可以主動告白；剛被拒絕就不行', () => {
    const crush = { stage: 'crush' as const, affinity: 65, trust: 50, romance: 60 };
    expect(romanceGuidance(crush).join()).toContain('avatar_confessed');
    const rejected = [{ type: 'confession_rejected' as const, note: '', at: new Date().toISOString() }];
    expect(romanceGuidance(crush, { events: rejected }).join()).not.toContain('avatar_confessed');
    expect(romanceGuidance(crush, { events: rejected }).join()).toContain('被拒絕');
    expect(romanceGuidance({ ...crush, romance: 40 }).join()).not.toContain('avatar_confessed');
  });
  it('告白後在等回答', () => {
    const events = [{ type: 'avatar_confessed' as const, note: '', at: new Date().toISOString() }];
    expect(romanceGuidance({ stage: 'crush', affinity: 65, trust: 50, romance: 62 }, { events }).join()).toContain('正在等對方的回答');
  });
  it('戀人與前任', () => {
    expect(romanceGuidance({ stage: 'lover', affinity: 70, trust: 60, romance: 70 }).join()).toContain('正在交往');
    expect(romanceGuidance({ stage: 'ex', affinity: 40, trust: 40, romance: 40 }).join()).toContain('got_back_together');
    expect(romanceGuidance({ stage: 'ex', affinity: 40, trust: 40, romance: 5 }).join()).toContain('moved_on');
  });
});

describe('decayMood', () => {
  it('隨時間回到平常', () => {
    const t0 = new Date('2026-10-19T00:00:00Z');
    const m = { label: '超開心', valence: 4, energy: -4 };
    expect(decayMood(m, t0, t0)).toEqual(m);
    expect(decayMood(m, t0, new Date('2026-10-19T08:00:00Z'))).toEqual({ label: '超開心', valence: 2, energy: -2 });
    expect(decayMood(m, t0, new Date('2026-10-20T12:00:00Z'))).toEqual({ label: '平常', valence: 0, energy: 0 });
  });
});
