// 用量統計與每日上限
export interface UsageTotals {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** 依設定檔的價格估算（美元）；沒有填價格的呼叫算 0 */
  costUsd: number;
}

export interface UsageSummaryDto {
  days: number;
  /** 今天（依設定的時區）的總用量與全域上限（0 = 不限） */
  today: UsageTotals & { limit: number };
  /** 這段期間 */
  total: UsageTotals;
  /** 每天，舊到新；date 是當地日期 YYYY-MM-DD */
  daily: (UsageTotals & { date: string })[];
  /** avatarId 為 null：系統工具模型的呼叫（補完角色、玩家摘要…） */
  byAvatar: (UsageTotals & { avatarId: string | null; todayTokens: number; limit: number })[];
  byPurpose: (UsageTotals & { purpose: string })[];
  byModel: (UsageTotals & { model: string; profileId: string | null })[];
}

/** 玩家在畫面上直接按的功能，不受每日上限限制（上限是為了擋住背景自動的呼叫） */
export const QUOTA_EXEMPT_PURPOSES: readonly string[] = ['persona.generate', 'persona.check', 'profile.summary', 'adult.test'];

export const USAGE_PURPOSE_LABELS: Record<string, string> = {
  reply: '回覆',
  'persona.generate': '補完角色',
  'persona.check': '一致性檢查',
  'profile.summary': '玩家摘要',
  'memory.extract': '記憶萃取',
  'memory.reflect': '整理印象',
  'life.log': '生活日誌',
  'image.caption': '描述圖片',
  'photo.generate': '拍照片',
  'adult.test': '成人內容測試',
};

export function totalTokens(t: Pick<UsageTotals, 'inputTokens' | 'outputTokens'>): number {
  return t.inputTokens + t.outputTokens;
}
