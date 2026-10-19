// 圖片的風格，以及每個 avatar 傳照片的方式
import { z } from 'zod';

export const IMAGE_STYLES = {
  anime: '日系動漫插畫風格，乾淨的線條與柔和上色',
  illustration: '溫暖的數位插畫風格',
  realistic: '寫實人像攝影，自然光，淺景深',
  watercolor: '水彩插畫風格',
  render3d: '3D 動畫電影角色風格',
} as const;
export type ImageStyle = keyof typeof IMAGE_STYLES;
export const IMAGE_STYLE_LABELS: Record<ImageStyle, string> = {
  anime: '動漫插畫',
  illustration: '數位插畫',
  realistic: '寫實照片',
  watercolor: '水彩',
  render3d: '3D 動畫',
};

export const PHOTO_APPEARS = ['self', 'proxy', 'none'] as const;
export type PhotoAppears = (typeof PHOTO_APPEARS)[number];
export const PHOTO_APPEARS_LABELS: Record<PhotoAppears, string> = {
  self: '自己入鏡（會自拍）',
  proxy: '用代替的東西入鏡（例如喜歡的娃娃）',
  none: '自己不入鏡（只拍東西和風景）',
};

export const PHOTO_REFERENCES = ['none', 'avatar', 'custom'] as const;
export type PhotoReference = (typeof PHOTO_REFERENCES)[number];
export const PHOTO_REFERENCE_LABELS: Record<PhotoReference, string> = {
  none: '不用參考圖',
  avatar: '用頭像',
  custom: '另外上傳一張',
};

export const avatarPhotoSchema = z.object({
  /** 這個 avatar 會不會傳照片（全域設定也要開著） */
  enabled: z.boolean().default(true),
  /** 照片裡怎麼出現 */
  appears: z.enum(PHOTO_APPEARS).default('self'),
  /** appears = proxy 時：代替自己入鏡的東西 */
  proxy: z.string().trim().max(200).default(''),
  /** 參考圖：讓入鏡的人（或代替的東西）每張都長得一樣 */
  reference: z.enum(PHOTO_REFERENCES).default('avatar'),
  /** 照片風格；null 表示跟全域設定 */
  style: z.enum(Object.keys(IMAGE_STYLES) as [ImageStyle, ...ImageStyle[]]).nullable().default(null),
});
export type AvatarPhoto = z.infer<typeof avatarPhotoSchema>;
export const DEFAULT_AVATAR_PHOTO: AvatarPhoto = avatarPhotoSchema.parse({});

/** 試拍一張：可以帶還沒儲存的設定 */
export const photoTestSchema = z.object({
  description: z.string().trim().min(1).max(500),
  photo: avatarPhotoSchema.optional(),
});

/** 哪些圖片模型能拿參考圖（Gemini 的圖片模型、OpenAI 的 gpt-image）；Imagen、DALL·E 不行 */
export function imageModelSupportsReference(provider: string, model: string): boolean {
  if (provider === 'google') return !/^(models\/)?imagen/.test(model);
  return /^gpt-image/.test(model);
}
