import { describe, expect, it } from 'vitest';
import { addressesEveryone, chooseSpeakers, mentions, type SpeakerCandidate } from './group.ts';

const c = (id: string, extra: Partial<SpeakerCandidate> = {}): SpeakerCandidate => ({
  id,
  name: id,
  status: 'free',
  extraversion: 50,
  affinity: 20,
  relevance: 0,
  recentMessages: 0,
  mentioned: false,
  ...extra,
});
const chosen = (r: ReturnType<typeof chooseSpeakers>) => r.filter((x) => x.chosen).map((x) => x.id);

describe('chooseSpeakers', () => {
  it('被點名的一定回，而且排在最前面', () => {
    const r = chooseSpeakers([c('a', { relevance: 1, extraversion: 100 }), c('b', { mentioned: true, extraversion: 0 })], {
      random: () => 0.5,
      forceOne: false,
    });
    expect(chosen(r)[0]).toBe('b');
  });

  it('話題相關、外向、喜歡玩家的人比較會回；最近講太多的人會讓給別人', () => {
    const r = chooseSpeakers(
      [c('talky', { relevance: 0.9, extraversion: 80, recentMessages: 6 }), c('fit', { relevance: 0.9, extraversion: 80 }), c('quiet', { extraversion: 10, affinity: -20 })],
      { random: () => 0.5, forceOne: false },
    );
    expect(chosen(r)).toEqual(['fit']);
  });

  it('睡覺的人不回（被點名也一樣）；忙碌的人分數打折', () => {
    const mid = { relevance: 0.5, extraversion: 100 };
    const r = chooseSpeakers([c('sleepy', { status: 'sleep', mentioned: true }), c('busy', { status: 'busy', ...mid })], {
      random: () => 1,
      forceOne: false,
    });
    expect(chosen(r)).toEqual([]);
    expect(r.find((x) => x.id === 'sleepy')!.why).toBe('睡覺中');
    // 同樣的條件，有空就會回
    expect(chosen(chooseSpeakers([c('free', mid)], { random: () => 1, forceOne: false }))).toEqual(['free']);
  });

  it('可能沒人回；但玩家問大家時至少一個人回', () => {
    const cands = [c('a', { extraversion: 10, affinity: -20 }), c('b', { extraversion: 20, affinity: -20 })];
    expect(chosen(chooseSpeakers(cands, { random: () => 0, forceOne: false }))).toEqual([]);
    expect(chosen(chooseSpeakers(cands, { random: () => 0, forceOne: true }))).toEqual(['b']);
  });

  it('玩家問大家時，普通的人也比較會開口', () => {
    const avg = [c('a', { affinity: 0 }), c('b', { affinity: 0 })];
    expect(chosen(chooseSpeakers(avg, { random: () => 0.5, forceOne: false }))).toEqual([]);
    expect(chosen(chooseSpeakers(avg, { random: () => 0.5, forceOne: true }))).toHaveLength(2);
  });

  it('最多 3 個人', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => c(id, { relevance: 1, extraversion: 100, affinity: 80 }));
    expect(chosen(chooseSpeakers(many, { random: () => 1, forceOne: false }))).toHaveLength(3);
  });
});

describe('mentions / addressesEveryone', () => {
  it('@名字或直接叫名字；單字名字只認 @', () => {
    expect(mentions('@雨 你在嗎', '雨')).toBe(true);
    expect(mentions('下雨了', '雨')).toBe(false);
    expect(mentions('小雨你覺得呢', '小雨')).toBe(true);
  });
  it('問句或對大家說話', () => {
    expect(addressesEveryone('大家晚安')).toBe(true);
    expect(addressesEveryone('今天好累喔')).toBe(false);
    expect(addressesEveryone('要吃什麼？')).toBe(true);
  });
});
