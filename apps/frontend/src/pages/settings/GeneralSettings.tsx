import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PACING_LABELS, PROVIDER_LABELS, type AppSettings, type ReplyPacing } from '@acc/shared';
import { LlmBindingEditor } from '../../components/LlmBindingEditor.tsx';
import { api, qk } from '../../lib/api.ts';
import { deepEqual } from '../../lib/equal.ts';
import { notificationsSupported, setNotifications, useNotificationsEnabled } from '../../lib/notify.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function GeneralSettings() {
  const { data } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  if (!data) return <p className="hint pad">載入中…</p>;
  return <GeneralForm key={JSON.stringify(data)} initial={data} />;
}

function GeneralForm({ initial }: { initial: AppSettings }) {
  const [s, setS] = useState(initial);
  const { data: profiles = [] } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const imageProfiles = profiles.filter((p) => p.provider !== 'anthropic');
  const toast = useToast();
  const qc = useQueryClient();
  const timezones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const dirty = !deepEqual(s, initial);

  const save = useMutation({
    mutationFn: () => api.updateSettings(s),
    onSuccess: (saved) => {
      qc.setQueryData(qk.settings, saved);
      toast('設定已儲存', 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const patch = (p: Partial<AppSettings>) => setS((prev) => ({ ...prev, ...p }));

  return (
    <form
      className="editor"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <header className="editor-head">
        <h1>一般設定</h1>
      </header>

      <section className="card">
        <h2>時間</h2>
        <label className="field">
          <span className="field-label">時區</span>
          <select value={s.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <span className="hint">avatar 的作息與你的勿擾時段都用這個時區計算。</span>
        </label>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.quietHours.enabled}
              onChange={(e) => patch({ quietHours: { ...s.quietHours, enabled: e.target.checked } })}
            />
            <span>勿擾時段（avatar 不會在這段時間主動傳訊息）</span>
          </label>
          {s.quietHours.enabled && (
            <div className="row">
              <input
                type="time"
                value={s.quietHours.start}
                onChange={(e) => patch({ quietHours: { ...s.quietHours, start: e.target.value } })}
                aria-label="開始"
              />
              <span>到</span>
              <input
                type="time"
                value={s.quietHours.end}
                onChange={(e) => patch({ quietHours: { ...s.quietHours, end: e.target.value } })}
                aria-label="結束"
              />
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h2>內容</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={s.adultContent}
            onChange={(e) => {
              if (e.target.checked && !confirm('開啟成人內容前，請確認你已年滿 18 歲。\n\n是否已年滿 18 歲？')) return;
              patch({ adultContent: e.target.checked });
            }}
          />
          <span>允許成人內容</span>
        </label>
        <p className="hint">
          雲端供應商（例如 Gemini）有各自的使用政策，可能仍會拒絕部分內容；需要時可以替個別 avatar 改綁限制較少的模型。所有 avatar 一律設定為成年人。
        </p>
      </section>

      <section className="card">
        <h2>聊天</h2>
        <label className="field">
          <span className="field-label">回覆節奏</span>
          <select value={s.replyPacing} onChange={(e) => patch({ replyPacing: e.target.value as ReplyPacing })}>
            {Object.entries(PACING_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <span className="hint">
            擬真模式下，avatar 依作息決定多久才看到訊息；一直傳訊息（尤其是「在嗎」「急」）會讓它提早看，睡覺時可能會被吵醒。
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.proactive.enabled}
            onChange={(e) => patch({ proactive: { ...s.proactive, enabled: e.target.checked } })}
          />
          <span>avatar 會主動傳訊息給你</span>
        </label>
        {s.proactive.enabled && (
          <label className="field">
            <span className="field-label">每個 avatar 每天最多主動傳幾次</span>
            <input
              type="number"
              className="narrow-input"
              min={0}
              max={20}
              value={s.proactive.dailyLimit}
              onChange={(e) =>
                patch({ proactive: { ...s.proactive, dailyLimit: Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0))) } })
              }
            />
            <span className="hint">避開上面的勿擾時段與 avatar 睡覺的時間；關係越近、越外向、越久沒聊，越常找你。</span>
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={s.showInnerThoughts}
            onChange={(e) => patch({ showInnerThoughts: e.target.checked })}
          />
          <span>顯示 avatar 的內心想法</span>
        </label>
        <p className="hint">在 avatar 訊息上方顯示它回覆時心裡在想什麼。偷看會少一點神秘感，但很適合用來調整角色設定。</p>
        <NotificationToggle />
      </section>

      <section className="card">
        <h2>系統工具模型</h2>
        <p className="hint">負責補完 avatar 設定、整理記憶、產生生活日誌與測驗摘要。建議選便宜、快速的模型。</p>
        <LlmBindingEditor value={s.utilityLlm} onChange={(utilityLlm) => patch({ utilityLlm })} />
      </section>

      <section className="card">
        <h2>記憶</h2>
        <p className="hint">
          avatar 用嵌入模型找出和目前對話相關的記憶。沒有設定時改用關鍵字與時間挑選，效果較差。記憶的整理與每日的印象由系統工具模型負責。
        </p>
        <label className="field">
          <span className="field-label">嵌入模型的設定檔</span>
          <select
            value={s.embedding?.profileId ?? ''}
            onChange={(e) =>
              patch({
                embedding: e.target.value
                  ? { profileId: e.target.value, model: s.embedding?.model || 'gemini-embedding-001' }
                  : null,
              })
            }
          >
            <option value="">（不使用）</option>
            {imageProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{PROVIDER_LABELS[p.provider]}）
              </option>
            ))}
          </select>
        </label>
        {s.embedding && (
          <label className="field">
            <span className="field-label">嵌入模型</span>
            <input
              value={s.embedding.model}
              list="embedding-models"
              onChange={(e) => patch({ embedding: { ...s.embedding!, model: e.target.value } })}
            />
            <datalist id="embedding-models">
              <option value="gemini-embedding-001" />
              <option value="text-embedding-3-small" />
            </datalist>
            <span className="hint">向量固定 768 維；換模型後，舊的記憶會在背景重新嵌入。</span>
          </label>
        )}
      </section>

      <section className="card">
        <h2>頭像生成</h2>
        <p className="hint">用哪個 LLM 設定檔的 API key 與端點，以及哪個圖片模型。支援 Google（Gemini 圖片模型、Imagen）與 OpenAI（相容）。</p>
        <label className="field">
          <span className="field-label">設定檔</span>
          <select
            value={s.imageGen?.profileId ?? ''}
            onChange={(e) =>
              patch({ imageGen: e.target.value ? { profileId: e.target.value, model: s.imageGen?.model ?? '' } : null })
            }
          >
            <option value="">（不使用）</option>
            {imageProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{PROVIDER_LABELS[p.provider]}）
              </option>
            ))}
          </select>
        </label>
        {s.imageGen && (
          <label className="field">
            <span className="field-label">圖片模型</span>
            <input
              value={s.imageGen.model}
              list="image-models"
              placeholder="例如 gemini-2.5-flash-image、imagen-4.0-generate-001、gpt-image-1"
              onChange={(e) => patch({ imageGen: { ...s.imageGen!, model: e.target.value } })}
            />
            <datalist id="image-models">
              <option value="gemini-2.5-flash-image" />
              <option value="imagen-4.0-generate-001" />
              <option value="gpt-image-1" />
            </datalist>
            <span className="hint">模型名稱以 imagen 開頭的走 Imagen API，其他 Google 模型走 Gemini 的圖片輸出。</span>
          </label>
        )}
      </section>

      <section className="card">
        <h2>除錯</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={s.debug.captureContext}
            onChange={(e) => patch({ debug: { ...s.debug, captureContext: e.target.checked } })}
          />
          <span>記錄每次 LLM 呼叫的完整 context（system prompt、對話、回應）</span>
        </label>
        <label className="field">
          <span className="field-label">事件與呼叫紀錄保留天數</span>
          <input
            type="number"
            className="narrow-input"
            min={1}
            max={90}
            value={s.debug.retentionDays}
            onChange={(e) =>
              patch({ debug: { ...s.debug, retentionDays: Math.max(1, Math.min(90, Math.round(Number(e.target.value) || 1))) } })
            }
          />
          <span className="hint">在左側的「監控」查看。紀錄存在你的伺服器上，不包含 API key。</span>
        </label>
      </section>

      <section className="card">
        <h2>費用</h2>
        <label className="field">
          <span className="field-label">每日 token 上限（所有 avatar 與系統工具加起來；0 表示不限）</span>
          <input
            type="number"
            min={0}
            step={1000}
            value={s.dailyTokenLimit}
            onChange={(e) => patch({ dailyTokenLimit: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
          <span className="hint">
            超過之後 avatar 暫時不回覆、不主動發話，也不整理記憶，隔天（依上面的時區）自動恢復；你自己按的「AI 補完」「一致性檢查」不受限。每個 avatar 也可以在「大腦」另外設上限。用量與費用在
            <Link to="/settings/usage">設定 → 用量</Link>。
          </span>
        </label>
      </section>

      <footer className="editor-foot">
        <span className="spacer" />
        {dirty && <span className="hint">有尚未儲存的變更</span>}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            !dirty || save.isPending || (!!s.imageGen && !s.imageGen.model.trim()) || (!!s.embedding && !s.embedding.model.trim())
          }
        >
          {save.isPending ? '儲存中…' : '儲存'}
        </button>
      </footer>
    </form>
  );
}

/** 通知權限是每個瀏覽器各自的，開關立刻生效，不用按「儲存」 */
function NotificationToggle() {
  const enabled = useNotificationsEnabled();
  const toast = useToast();
  if (!notificationsSupported) return <p className="hint">這個瀏覽器不支援通知。</p>;
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={async (e) => {
            const want = e.target.checked;
            const ok = await setNotifications(want);
            if (want && !ok) toast('瀏覽器沒有允許通知，請到瀏覽器的網站設定開啟', 'error');
          }}
        />
        <span>瀏覽器通知</span>
      </label>
      <p className="hint">這個分頁在背景時，avatar 傳來訊息會跳出通知。只對這個瀏覽器有效，馬上生效。</p>
    </>
  );
}
