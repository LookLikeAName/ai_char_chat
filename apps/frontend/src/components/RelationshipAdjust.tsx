// 手動調整和玩家的關係：階段、好感、信任、心動。也可以一鍵套用某個階段的起始值。
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { INITIAL_STAGES, INITIAL_VALUES, STAGE_LABELS, type InitialStage, type RelationshipState, type Stage } from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { useStageOptions } from '../lib/stages.ts';
import { errorText, useToast } from '../lib/toast.tsx';

const METERS = [
  { key: 'affinity', label: '好感', min: -100, max: 100 },
  { key: 'trust', label: '信任', min: 0, max: 100 },
  { key: 'romance', label: '心動', min: 0, max: 100 },
] as const;

export function RelationshipAdjust({ avatarId, current }: { avatarId: string; current: RelationshipState }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { all } = useStageOptions(current.stage);
  const initialForm = { stage: current.stage, affinity: current.affinity, trust: current.trust, romance: current.romance ?? 0 };
  const [form, setForm] = useState(initialForm);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const isInitial = (INITIAL_STAGES as readonly Stage[]).includes(form.stage);

  const save = useMutation({
    mutationFn: () => api.patchRelationship(avatarId, form),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.avatarState(avatarId) });
      toast('已調整關係', 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <div className="rel-adjust">
      <label className="field">
        <span className="field-label">階段</span>
        <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as Stage })}>
          {all.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      {METERS.map((m) => (
        <label key={m.key} className="field rel-meter">
          <span className="field-label">
            {m.label}
            <input
              type="number"
              className="narrow-input"
              min={m.min}
              max={m.max}
              value={form[m.key]}
              onChange={(e) => setForm({ ...form, [m.key]: Math.max(m.min, Math.min(m.max, Math.round(Number(e.target.value) || 0))) })}
              aria-label={`${m.label}（數字）`}
            />
          </span>
          <input
            type="range"
            min={m.min}
            max={m.max}
            value={form[m.key]}
            onChange={(e) => setForm({ ...form, [m.key]: Number(e.target.value) })}
            aria-label={m.label}
          />
        </label>
      ))}
      <div className="row">
        {isInitial && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setForm({ stage: form.stage, ...INITIAL_VALUES[form.stage as InitialStage] })}>
            套用「{STAGE_LABELS[form.stage]}」的起始值
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn-small btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '儲存中…' : '儲存調整'}
        </button>
      </div>
      <p className="hint">直接改成你設定的值（不受升降階的規則限制），記憶不會刪除；之後一樣會隨聊天變化。</p>
    </div>
  );
}
