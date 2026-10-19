import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings } from '@acc/shared';
import { LlmBindingEditor } from '../../components/LlmBindingEditor.tsx';
import { api, qk } from '../../lib/api.ts';
import { deepEqual } from '../../lib/equal.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function GeneralSettings() {
  const { data } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  if (!data) return <p className="hint pad">載入中…</p>;
  return <GeneralForm key={JSON.stringify(data)} initial={data} />;
}

function GeneralForm({ initial }: { initial: AppSettings }) {
  const [s, setS] = useState(initial);
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
        <h2>系統工具模型</h2>
        <p className="hint">負責補完 avatar 設定、整理記憶、產生生活日誌與測驗摘要。建議選便宜、快速的模型。</p>
        <LlmBindingEditor value={s.utilityLlm} onChange={(utilityLlm) => patch({ utilityLlm })} />
      </section>

      <section className="card">
        <h2>用量</h2>
        <label className="field">
          <span className="field-label">每日 token 上限（0 表示不限）</span>
          <input
            type="number"
            min={0}
            step={1000}
            value={s.dailyTokenLimit}
            onChange={(e) => patch({ dailyTokenLimit: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
          <span className="hint">用量統計與上限在第 8 階段生效。</span>
        </label>
      </section>

      <footer className="editor-foot">
        <span className="spacer" />
        {dirty && <span className="hint">有尚未儲存的變更</span>}
        <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
          {save.isPending ? '儲存中…' : '儲存'}
        </button>
      </footer>
    </form>
  );
}
