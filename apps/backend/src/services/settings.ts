import { eq } from 'drizzle-orm';
import { appSettingsSchema, type AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';

const SETTINGS_ID = 1;

export async function loadSettings(db: Db): Promise<AppSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID));
  // 舊版或手動改壞的值不要讓整個系統掛掉：解析失敗就逐欄退回預設值
  const r = appSettingsSchema.safeParse(row?.data ?? {});
  if (r.success) return r.data;
  const defaults = appSettingsSchema.parse({});
  const raw = (row?.data ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof AppSettings)[]) {
    const field = appSettingsSchema.shape[key].safeParse(raw[key]);
    if (field.success) merged[key] = field.data;
  }
  return merged as AppSettings;
}

export async function saveSettings(db: Db, value: AppSettings): Promise<void> {
  await db
    .insert(settings)
    .values({ id: SETTINGS_ID, data: value })
    .onConflictDoUpdate({ target: settings.id, set: { data: value, updatedAt: new Date() } });
}
