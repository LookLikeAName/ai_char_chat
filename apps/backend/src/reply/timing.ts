// 模擬真人的節奏：看到訊息後稍等一下才開始打字，打字時間跟長度成正比。
// 第 6 階段會再依作息（忙碌、睡覺）加上更長的延遲。

export type Random = () => number;

function jitter(ms: number, random: Random, spread = 0.25): number {
  return Math.round(ms * (1 - spread + random() * spread * 2));
}

/** 玩家送出後多久 avatar 開始處理（同時也是連續訊息的合併時間） */
export function debounceMs(random: Random): number {
  return 1200 + Math.round(random() * 1300);
}

/** 已讀之後、開始打字之前的停頓 */
export function readPauseMs(random: Random): number {
  return 600 + Math.round(random() * 1200);
}

const TYPING_SPEED = { slow: 1.6, normal: 1, fast: 0.6 } as const;

/** 打一則訊息的時間：每字約 110ms（依角色的打字速度調整），介於 0.8～7 秒 */
export function typingMs(text: string, random: Random, speed: keyof typeof TYPING_SPEED = 'normal'): number {
  const chars = [...text].length;
  return Math.min(7000, Math.max(800, jitter(chars * 110 * TYPING_SPEED[speed], random)));
}

/** 兩則訊息之間的間隔 */
export function betweenMessagesMs(random: Random): number {
  return 300 + Math.round(random() * 600);
}
