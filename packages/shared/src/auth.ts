// 簡單的密碼登入：沒有設定密碼時不需要登入（只在本機使用）；設定後整個網站都要先登入。
import { z } from 'zod';

export interface AuthStatusDto {
  /** 有設定密碼 */
  enabled: boolean;
  authenticated: boolean;
  /** 密碼由環境變數 APP_PASSWORD 設定，不能在網頁上修改 */
  managedByEnv: boolean;
}

export const loginSchema = z.object({
  password: z.string().min(1, '請輸入密碼').max(200),
  /** 記住這台裝置 30 天；不勾的話關掉瀏覽器就要重新登入 */
  remember: z.boolean().default(false),
});

export const PASSWORD_MIN = 8;

export const passwordChangeSchema = z.object({
  /** 已經有密碼時必填 */
  current: z.string().max(200).optional(),
  /** null 表示移除密碼（不再需要登入） */
  next: z.string().min(PASSWORD_MIN, `密碼至少 ${PASSWORD_MIN} 個字`).max(200).nullable(),
});
