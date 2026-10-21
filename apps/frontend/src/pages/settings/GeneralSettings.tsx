import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  IMAGE_STYLE_LABELS,
  PACING_LABELS,
  PROFILE_KIND_LABELS,
  PROVIDER_LABELS,
  UTILITY_TASK_LABELS,
  UTILITY_TASKS,
  type AppSettings,
  type LlmProfileDto,
  type ReplyPacing,
  type UtilityTask,
} from '@acc/shared';
import { AdultTestPanel } from '../../components/AdultTestPanel.tsx';
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
  const imageProfiles = profiles.filter((p) => p.kind === 'image');
  const embeddingProfiles = profiles.filter((p) => p.kind === 'embedding');
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
          內容的尺度由這個開關決定。Gemini 可以調整的安全過濾一律設成不擋（避免正常的吐槽、吵架被誤判），但雲端供應商仍有關不掉的使用政策，可能拒絕部分內容；可以用下面的測試看看，需要時替個別 avatar 改綁限制較少的模型。所有 avatar 一律設定為成年人。
        </p>
        {s.adultContent && <AdultTestPanel />}
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
        {s.proactive.enabled && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={s.proactive.catchUp}
                onChange={(e) => patch({ proactive: { ...s.proactive, catchUp: e.target.checked } })}
              />
              <span>系統沒開著的期間，啟動時補上那段時間的主動訊息</span>
            </label>
            <p className="hint">
              停機超過 30 分鐘時，照平常的規則回頭檢查那段時間（最多最近 48 小時），決定要傳的就用那個時間點的情境寫訊息，訊息也標成那個時間，就像那時候傳來的。一次最多補 8 次，每次都要呼叫 LLM。
            </p>
          </>
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
        <UtilityTasks
          value={s.utilityByTask}
          onChange={(utilityByTask) => patch({ utilityByTask })}
          profiles={profiles.filter((p) => p.kind === 'chat')}
          fallback={profiles.find((p) => p.id === s.utilityLlm?.profileId)}
        />
      </section>

      <section className="card">
        <h2>記憶</h2>
        <p className="hint">
          avatar 用嵌入模型找出和目前對話相關的記憶。沒有設定時改用關鍵字與時間挑選，效果較差。記憶的整理與每日的印象由系統工具模型負責。
        </p>
        <ProfilePicker
          label="嵌入模型"
          kind="embedding"
          options={embeddingProfiles}
          value={s.embedding?.profileId ?? null}
          onChange={(profileId) => patch({ embedding: profileId ? { profileId } : null })}
          hint="換模型後，舊的記憶會在背景重新嵌入。"
        />
      </section>

      <section className="card">
        <h2>頭像與照片生成</h2>
        <p className="hint">AI 生成頭像、avatar 傳照片都用這裡選的圖片模型。支援 Google（Gemini 圖片模型、Imagen）與 OpenAI（相容）。</p>
        <ProfilePicker
          label="圖片模型"
          kind="image"
          options={imageProfiles}
          value={s.imageGen?.profileId ?? null}
          onChange={(profileId) => patch({ imageGen: profileId ? { profileId } : null })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={s.photos.enabled}
            onChange={(e) => patch({ photos: { ...s.photos, enabled: e.target.checked } })}
          />
          <span>avatar 可以傳照片給你</span>
        </label>
        {s.photos.enabled && (
          <div className="row">
            <label className="field">
              <span className="field-label">每個 avatar 每天最多幾張</span>
              <input
                type="number"
                className="narrow-input"
                min={0}
                max={50}
                value={s.photos.dailyLimit}
                onChange={(e) =>
                  patch({ photos: { ...s.photos, dailyLimit: Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0))) } })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">照片風格</span>
              <select
                value={s.photos.style}
                onChange={(e) => patch({ photos: { ...s.photos, style: e.target.value as AppSettings['photos']['style'] } })}
              >
                {Object.entries(IMAGE_STYLE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <p className="hint">
          avatar 會在自然的時候傳照片（你想看、分享吃的東西或風景、自拍）。每個 avatar 可以在自己的「基本資料 → 照片」設定入鏡方式（自己、用娃娃之類的代替、不入鏡）、參考圖與風格；這裡的風格是預設值。每張照片都要付圖片模型的費用。
          {!s.imageGen && s.photos.enabled && ' 要先選好上面的圖片模型才會傳。'}
        </p>
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
            !dirty || save.isPending
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

/** 選一個「圖片生成」或「記憶嵌入」用的設定檔；模型就是設定檔裡的模型 */
/** 依功能指定系統工具模型；沒指定的用上面的預設 */
function UtilityTasks({
  value,
  onChange,
  profiles,
  fallback,
}: {
  value: AppSettings['utilityByTask'];
  onChange: (v: AppSettings['utilityByTask']) => void;
  profiles: LlmProfileDto[];
  fallback: LlmProfileDto | undefined;
}) {
  const custom = UTILITY_TASKS.filter((t) => value[t]).length;
  const set = (task: UtilityTask, profileId: string) => {
    const next = { ...value };
    if (profileId) next[task] = { profileId, params: value[task]?.profileId === profileId ? value[task]!.params : {} };
    else delete next[task];
    onChange(next);
  };
  return (
    <details className="utility-tasks" open={custom > 0}>
      <summary>依功能指定模型{custom ? `（已指定 ${custom} 項）` : ''}</summary>
      <p className="hint">例如補完角色用好一點的模型、摘要與記憶用便宜的。沒有指定的用上面的預設模型，參數用設定檔的預設值。</p>
      {UTILITY_TASKS.map((task) => {
        const picked = profiles.find((p) => p.id === value[task]?.profileId);
        const used = picked ?? fallback;
        return (
          <label key={task} className="field">
            <span className="field-label">{UTILITY_TASK_LABELS[task].title}</span>
            <select value={value[task]?.profileId ?? ''} onChange={(e) => set(task, e.target.value)}>
              <option value="">跟預設一樣{fallback ? `（${fallback.name}）` : ''}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.model}）
                </option>
              ))}
            </select>
            <span className="hint">
              {UTILITY_TASK_LABELS[task].hint}
              {task === 'caption' && used && !used.vision && <span className="warn-text">。「{used.name}」看不懂圖片，不會替圖片寫描述。</span>}
            </span>
          </label>
        );
      })}
    </details>
  );
}

function ProfilePicker({
  label,
  kind,
  options,
  value,
  onChange,
  hint,
}: {
  label: string;
  kind: 'image' | 'embedding';
  options: LlmProfileDto[];
  value: string | null;
  onChange: (profileId: string | null) => void;
  hint?: string;
}) {
  const selected = options.find((p) => p.id === value);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">（不使用）</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}（{PROVIDER_LABELS[p.provider]} · {p.model}）
          </option>
        ))}
      </select>
      <span className="hint">
        {options.length === 0 ? (
          <>
            還沒有{PROFILE_KIND_LABELS[kind]}用的設定檔，
            <Link to={`/settings/llm?new=${kind}`}>到 LLM 設定檔新增一個</Link>（可以用同一把 API key）。
          </>
        ) : (
          <>
            {selected ? `使用模型 ${selected.model}。` : ''}
            {hint}要換模型或新增，到 <Link to="/settings/llm">LLM 設定檔</Link>。
          </>
        )}
      </span>
    </label>
  );
}
