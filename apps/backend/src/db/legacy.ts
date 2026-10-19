// 舊版設定的轉換：以前「頭像生成」「記憶」是選一個設定檔、再另外填模型名稱；
// 現在設定檔有用途（聊天、圖片生成、記憶嵌入），模型就是設定檔裡的模型。
// 啟動時做一次：舊設定裡的模型名稱搬進一個對應用途的設定檔。
import { eq, sql } from 'drizzle-orm';
import type { ProfileKind } from '@acc/shared';
import type { Db } from './client.ts';
import { avatars, llmProfiles, settings } from './schema.ts';

const ROLES: { key: 'imageGen' | 'embedding'; kind: ProfileKind; suffix: string }[] = [
  { key: 'imageGen', kind: 'image', suffix: '（圖片）' },
  { key: 'embedding', kind: 'embedding', suffix: '（嵌入）' },
];

type LegacyRef = { profileId?: unknown; model?: unknown } | null | undefined;

export async function migrateLegacyProfileSettings(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for('update');
    if (!row) return;
    const data = { ...(row.data as Record<string, unknown>) };
    let changed = false;
    for (const role of ROLES) {
      const ref = data[role.key] as LegacyRef;
      if (!ref || typeof ref.model !== 'string' || typeof ref.profileId !== 'string') continue;
      changed = true;
      const [p] = await tx.select().from(llmProfiles).where(eq(llmProfiles.id, ref.profileId));
      if (!p) {
        data[role.key] = null;
        continue;
      }
      const utility = (data.utilityLlm as { profileId?: string } | null)?.profileId === p.id;
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(avatars)
        .where(sql`${avatars.llm}->>'profileId' = ${p.id}`)) as [{ n: number }];
      let profileId = p.id;
      if (p.kind === role.kind && p.model === ref.model) {
        // 已經是對的
      } else if (p.kind === 'chat' && !utility && Number(n) === 0) {
        // 沒有拿來聊天：直接改成這個用途
        await tx.update(llmProfiles).set({ kind: role.kind, model: ref.model, updatedAt: new Date() }).where(eq(llmProfiles.id, p.id));
      } else {
        // 也拿來聊天（或已經改成別的用途）：複製一份，共用同一把 key
        const [copy] = await tx
          .insert(llmProfiles)
          .values({
            kind: role.kind,
            name: `${p.name}${role.suffix}`.slice(0, 60),
            provider: p.provider,
            baseUrl: p.baseUrl,
            model: ref.model,
            apiKeyEnc: p.apiKeyEnc,
            apiKeyHint: p.apiKeyHint,
          })
          .returning();
        profileId = copy!.id;
      }
      data[role.key] = { profileId };
    }
    if (changed) await tx.update(settings).set({ data, updatedAt: new Date() }).where(eq(settings.id, 1));
  });
}
