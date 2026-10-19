// 把玩家的測驗結果與偏好寫成文字：給系統工具模型寫摘要，也在沒有摘要時直接放進回覆 prompt。
import {
  AGE_RANGES,
  ATTACHMENT_LABELS,
  BIG_FIVE,
  BIG_FIVE_LABELS,
  CHAT_STYLES,
  ROMANCE_PREFS,
  SCHWARTZ_LABELS,
  type AssessmentResults,
  type Preferences,
} from '@acc/shared';

function level(score: number): string {
  if (score >= 80) return '很高';
  if (score >= 60) return '偏高';
  if (score > 40) return '中等';
  if (score > 20) return '偏低';
  return '很低';
}

export function describePreferences(p: Preferences): string[] {
  return [
    `希望被稱呼為：${p.nickname}`,
    p.gender && `性別：${p.gender}`,
    p.ageRange && `年齡：${AGE_RANGES[p.ageRange]}`,
    p.lifeSituation && `工作或生活狀態：${p.lifeSituation}`,
    p.interests.length && `興趣：${p.interests.join('、')}`,
    p.chatStyles.length && `喜歡的聊天方式：${p.chatStyles.map((c) => CHAT_STYLES[c]).join('、')}`,
    p.romance && `對戀愛的期待：${ROMANCE_PREFS[p.romance]}`,
    p.attractedTo && `喜歡的對象：${p.attractedTo}`,
    p.routine && `作息：${p.routine}`,
    p.about && `想讓人知道的事：${p.about}`,
  ].filter((x): x is string => !!x);
}

export function describeResults(r: AssessmentResults): string[] {
  const lines: string[] = [];
  if (r.bigFive) {
    lines.push(
      `五大人格（0–100）：${BIG_FIVE.map((t) => `${BIG_FIVE_LABELS[t]} ${r.bigFive!.scores[t]}（${level(r.bigFive!.scores[t])}）`).join('、')}`,
    );
  }
  if (r.attachment) {
    lines.push(
      `依附（1–7）：焦慮 ${r.attachment.anxiety}、逃避 ${r.attachment.avoidance}，大致是${ATTACHMENT_LABELS[r.attachment.style]}`,
    );
  }
  if (r.values) {
    const top = r.values.ranking.slice(0, 3).map((v) => SCHWARTZ_LABELS[v]);
    const bottom = r.values.ranking.slice(-2).map((v) => SCHWARTZ_LABELS[v]);
    lines.push(`最重視的價值：${top.join('、')}；最不重視：${bottom.join('、')}`);
  }
  return lines;
}
