import { describe, expect, it } from 'vitest';
import { intimacyLevel, visibleStage } from './intimacy.ts';
import { nextStage, type RelationshipState } from './relationship.ts';

const at = (relationship: RelationshipState, extra: Omit<Parameters<typeof intimacyLevel>[0], 'relationship'> = {}) =>
  intimacyLevel({ relationship, ...extra });

describe('intimacyLevel：程式決定最多到哪一層', () => {
  it('依關係：陌生不碰、朋友調情、曖昧親密接觸、戀人與炮友露骨', () => {
    expect(at({ stage: 'stranger', affinity: 50, trust: 50 })).toBe('none');
    expect(at({ stage: 'friend', affinity: 30, trust: 30 })).toBe('flirt');
    expect(at({ stage: 'crush', affinity: 55, trust: 40 })).toBe('touch');
    expect(at({ stage: 'lover', affinity: 70, trust: 60 })).toBe('explicit');
    expect(at({ stage: 'fwb', affinity: 45, trust: 40, romance: 5 })).toBe('explicit');
  });
  it('數值不夠會降：沒好感不調情、信任不夠不露骨', () => {
    expect(at({ stage: 'friend', affinity: 10, trust: 30 })).toBe('none');
    expect(at({ stage: 'lover', affinity: 70, trust: 35 })).toBe('touch');
    expect(at({ stage: 'crush', affinity: 35, trust: 40 })).toBe('flirt');
  });
  it('開放程度：很開放的朋友可能更進一步、認識就會開玩笑；很保守的戀人降一層', () => {
    expect(at({ stage: 'friend', affinity: 50, trust: 40 }, { openness: 80 })).toBe('touch');
    expect(at({ stage: 'acquaintance', affinity: 25, trust: 20 }, { openness: 80 })).toBe('flirt');
    expect(at({ stage: 'stranger', affinity: 25, trust: 20 }, { openness: 100 })).toBe('none');
    expect(at({ stage: 'lover', affinity: 70, trust: 60 }, { openness: 20 })).toBe('touch');
  });
  it('心情很差、玩家只想當朋友（炮友除外）、群組裡都會收斂', () => {
    const lover = { stage: 'lover' as const, affinity: 70, trust: 60 };
    expect(at(lover, { mood: { label: '很難過', valence: -4, energy: -2 } })).toBe('touch');
    expect(at(lover, { romancePref: 'none' })).toBe('flirt');
    expect(at({ stage: 'fwb', affinity: 50, trust: 45 }, { romancePref: 'none' })).toBe('explicit');
    expect(at(lover, { inGroup: true })).toBe('flirt');
  });
});

describe('炮友', () => {
  it('朋友以上、數值夠才能說好；動了真感情可以變曖昧或戀人；結束回到朋友', () => {
    expect(nextStage('friend', 40, 35, 'became_fwb')).toBe('fwb');
    expect(nextStage('acquaintance', 40, 35, 'became_fwb')).not.toBe('fwb');
    expect(nextStage('friend', 30, 35, 'became_fwb')).toBe('friend');
    expect(nextStage('fwb', 80, 80)).toBe('fwb');
    expect(nextStage('fwb', 50, 40, 'mutual_feelings', 40)).toBe('crush');
    expect(nextStage('fwb', 65, 50, 'confession_accepted', 60)).toBe('lover');
    expect(nextStage('fwb', 40, 35, 'ended_fwb')).toBe('friend');
    expect(nextStage('fwb', -30, 35)).toBe('cold');
  });
  it('沒開成人內容時當作好友', () => {
    expect(visibleStage('fwb', false)).toBe('close');
    expect(visibleStage('fwb', true)).toBe('fwb');
    expect(visibleStage('lover', false)).toBe('lover');
  });
});
