import { useState } from 'react';
import { AGE_RANGES, CHAT_STYLES, ROMANCE_PREFS, type Preferences } from '@acc/shared';
import { ListEditor } from './ListEditor.tsx';

export const EMPTY_PREFERENCES: Preferences = {
  nickname: '',
  gender: '',
  ageRange: null,
  lifeSituation: '',
  interests: [],
  chatStyles: [],
  avoidTopics: [],
  romance: null,
  attractedTo: '',
  routine: '',
  about: '',
};

interface Props {
  initial: Preferences | null;
  submitLabel: string;
  saving: boolean;
  onSubmit: (p: Preferences) => void;
}

export function PreferencesForm({ initial, submitLabel, saving, onSubmit }: Props) {
  const [p, setP] = useState<Preferences>(initial ?? EMPTY_PREFERENCES);
  const patch = (x: Partial<Preferences>) => setP((prev) => ({ ...prev, ...x }));

  return (
    <form
      className="prefs"
      onSubmit={(e) => {
        e.preventDefault();
        if (p.nickname.trim()) onSubmit(p);
      }}
    >
      <label className="field">
        <span className="field-label">希望 avatar 怎麼稱呼你？（必填）</span>
        <input value={p.nickname} onChange={(e) => patch({ nickname: e.target.value })} maxLength={40} required />
      </label>
      <div className="prefs-grid">
        <label className="field">
          <span className="field-label">性別</span>
          <input value={p.gender} onChange={(e) => patch({ gender: e.target.value })} placeholder="選填" />
        </label>
        <label className="field">
          <span className="field-label">年齡</span>
          <select
            value={p.ageRange ?? ''}
            onChange={(e) => patch({ ageRange: (e.target.value || null) as Preferences['ageRange'] })}
          >
            <option value="">不透露</option>
            {Object.entries(AGE_RANGES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field-label">工作或生活狀態</span>
        <input
          value={p.lifeSituation}
          onChange={(e) => patch({ lifeSituation: e.target.value })}
          placeholder="例如：軟體工程師，最近在準備轉職"
        />
      </label>
      <div className="field">
        <span className="field-label">興趣</span>
        <ListEditor value={p.interests} onChange={(interests) => patch({ interests })} placeholder="例如：爬山、推理小說" />
      </div>
      <fieldset className="field">
        <legend className="field-label">喜歡的聊天方式（可複選）</legend>
        <div className="chips-select">
          {Object.entries(CHAT_STYLES).map(([k, v]) => {
            const key = k as keyof typeof CHAT_STYLES;
            const on = p.chatStyles.includes(key);
            return (
              <label key={k} className={`chip-toggle${on ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    patch({ chatStyles: on ? p.chatStyles.filter((c) => c !== key) : [...p.chatStyles, key] })
                  }
                />
                {v}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="field">
        <span className="field-label">不想聊的話題</span>
        <ListEditor
          value={p.avoidTopics}
          onChange={(avoidTopics) => patch({ avoidTopics })}
          placeholder="avatar 不會主動提起，例如：工作、前任"
        />
      </div>
      <div className="prefs-grid">
        <label className="field">
          <span className="field-label">對戀愛的期待</span>
          <select
            value={p.romance ?? ''}
            onChange={(e) => patch({ romance: (e.target.value || null) as Preferences['romance'] })}
          >
            <option value="">還不確定</option>
            {Object.entries(ROMANCE_PREFS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">喜歡的對象</span>
          <input value={p.attractedTo} onChange={(e) => patch({ attractedTo: e.target.value })} placeholder="例如：女生、不限" />
        </label>
      </div>
      <label className="field">
        <span className="field-label">你平常的作息</span>
        <input
          value={p.routine}
          onChange={(e) => patch({ routine: e.target.value })}
          placeholder="例如：平日 9 點到 6 點上班，晚上 11 點後比較有空"
        />
      </label>
      <label className="field">
        <span className="field-label">還有什麼想讓 avatar 知道的？</span>
        <textarea rows={3} value={p.about} onChange={(e) => patch({ about: e.target.value })} maxLength={1000} />
      </label>
      <div className="row">
        <span className="spacer" />
        <button type="submit" className="btn btn-primary" disabled={saving || !p.nickname.trim()}>
          {saving ? '儲存中…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
