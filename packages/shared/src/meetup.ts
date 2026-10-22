// 見面模式：和 avatar「約出來」面對面聊天。介面變成面對面的樣子，回覆不經過作息與打字的延遲，
// 每一句都可以帶旁白（表情、動作、語氣）。玩家也一樣可以寫自己的動作和台詞。
import { z } from 'zod';

export interface MeetupDto {
  id: string;
  conversationId: string;
  place: string;
  /** 情境，例如「第一次約會」 */
  note: string;
  startedAt: string;
  endedAt: string | null;
  /** 誰結束的：玩家、avatar 自己說要走 */
  endedBy: 'user' | 'avatar' | null;
}

export const meetupStartSchema = z.object({
  place: z.string().trim().min(1, '請寫見面的地點').max(100),
  note: z.string().trim().max(300).default(''),
  /** 你怎麼出現（選填）：寫了就當成你的第一個動作，avatar 會對它反應；沒寫就由 avatar 先開口 */
  opening: z.string().trim().max(1000).default(''),
});
export type MeetupStartInput = z.input<typeof meetupStartSchema>;

/** 一場見面最多可以多長，超過就自動結束（忘了按結束） */
export const MEETUP_MAX_MS = 12 * 60 * 60 * 1000;
