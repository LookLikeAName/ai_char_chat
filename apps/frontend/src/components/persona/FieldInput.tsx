// 人格欄位的輸入元件，依欄位類型切換。
import { useState } from 'react';
import {
  BIG_FIVE,
  BIG_FIVE_LABELS,
  ENUM_OPTIONS,
  SCHWARTZ_LABELS,
  SCHWARTZ_VALUES,
  type FieldMeta,
  type Schedule,
  type ScheduleBlock,
  type SchwartzValue,
} from '@acc/shared';

interface Props {
  id: string;
  meta: FieldMeta;
  value: unknown;
  onChange: (v: unknown) => void;
}

export function FieldInput({ id, meta, value, onChange }: Props) {
  switch (meta.type) {
    case 'text':
      return <input id={id} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={200} />;
    case 'long':
      return (
        <textarea id={id} rows={3} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={2000} />
      );
    case 'number':
      return (
        <input
          id={id}
          type="number"
          className="narrow-input"
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Math.round(Number(e.target.value)))}
        />
      );
    case 'scale':
      return <ScaleInput id={id} value={value as number | undefined} labels={meta.scaleLabels} onChange={onChange} />;
    case 'select':
      return (
        <select id={id} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">（未選）</option>
          {Object.entries(meta.options ?? {}).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      );
    case 'list':
      return <ListInput id={id} value={(value as string[]) ?? []} onChange={onChange} />;
    case 'bigFive':
      return <BigFiveInput value={value as Record<string, number> | undefined} onChange={onChange} />;
    case 'ranking':
      return <RankingInput value={value as SchwartzValue[] | undefined} onChange={onChange} />;
    case 'schedule':
      return <ScheduleInput value={value as Schedule | undefined} onChange={onChange} />;
  }
}

function ScaleInput({
  id,
  value,
  labels,
  onChange,
}: {
  id: string;
  value: number | undefined;
  labels?: [string, string];
  onChange: (v: number) => void;
}) {
  return (
    <div className="scale">
      <span className="hint">{labels?.[0]}</span>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={value ?? 50}
        className={value === undefined ? 'unset' : ''}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="hint">{labels?.[1]}</span>
      <span className="scale-value">{value ?? '—'}</span>
    </div>
  );
}

function ListInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[] | undefined) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="list-input">
      {value.map((item, i) => (
        <span key={`${i}-${item}`} className="chip">
          {item}
          <button
            type="button"
            aria-label={`移除 ${item}`}
            onClick={() => {
              const next = value.filter((_, j) => j !== i);
              onChange(next.length ? next : undefined);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length ? '再加一項，按 Enter' : '輸入後按 Enter'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

function BigFiveInput({ value, onChange }: { value?: Record<string, number>; onChange: (v: unknown) => void }) {
  const v = value ?? {};
  return (
    <div className="bigfive">
      {BIG_FIVE.map((k) => (
        <label key={k} className="bigfive-row">
          <span>{BIG_FIVE_LABELS[k]}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={v[k] ?? 50}
            className={v[k] === undefined ? 'unset' : ''}
            onChange={(e) => {
              // 五個向度一起設定；第一次動到時其他向度從 50 開始
              const base = Object.fromEntries(BIG_FIVE.map((t) => [t, v[t] ?? 50]));
              onChange({ ...base, [k]: Number(e.target.value) });
            }}
          />
          <span className="scale-value">{v[k] ?? '—'}</span>
        </label>
      ))}
    </div>
  );
}

function RankingInput({ value, onChange }: { value?: SchwartzValue[]; onChange: (v: SchwartzValue[]) => void }) {
  const list = value?.length === SCHWARTZ_VALUES.length ? value : null;
  if (!list) {
    return (
      <div className="ranking-empty">
        <span className="hint">還沒有排序。</span>
        <button type="button" className="btn btn-small" onClick={() => onChange([...SCHWARTZ_VALUES])}>
          手動排序
        </button>
      </div>
    );
  }
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  return (
    <ol className="ranking">
      {list.map((v, i) => (
        <li key={v}>
          <span>{SCHWARTZ_LABELS[v]}</span>
          <span className="ranking-btns">
            <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="往上">
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={i === list.length - 1}
              onClick={() => move(i, 1)}
              aria-label="往下"
            >
              ↓
            </button>
          </span>
        </li>
      ))}
    </ol>
  );
}

const EMPTY_BLOCK: ScheduleBlock = { start: '09:00', end: '18:00', activity: '', status: 'busy' };

function ScheduleInput({ value, onChange }: { value?: Schedule; onChange: (v: Schedule) => void }) {
  const s: Schedule = { weekday: value?.weekday ?? [], weekend: value?.weekend ?? [] };
  const update = (day: keyof Schedule, blocks: ScheduleBlock[]) => onChange({ ...s, [day]: blocks });
  return (
    <div className="schedule">
      {(['weekday', 'weekend'] as const).map((day) => (
        <div key={day} className="schedule-day">
          <div className="schedule-day-title">{day === 'weekday' ? '平日' : '假日'}</div>
          {s[day].map((b, i) => {
            const set = (patch: Partial<ScheduleBlock>) => update(day, s[day].map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="schedule-row">
                <input type="time" value={b.start} onChange={(e) => set({ start: e.target.value })} aria-label="開始" />
                <span>–</span>
                <input type="time" value={b.end} onChange={(e) => set({ end: e.target.value })} aria-label="結束" />
                <input
                  className="grow"
                  value={b.activity}
                  placeholder="在做什麼"
                  onChange={(e) => set({ activity: e.target.value })}
                  aria-label="活動"
                />
                <select
                  value={b.status}
                  onChange={(e) => set({ status: e.target.value as ScheduleBlock['status'] })}
                  aria-label="狀態"
                >
                  {Object.entries(ENUM_OPTIONS.scheduleStatus).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="刪除這個時段"
                  onClick={() => update(day, s[day].filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button type="button" className="btn btn-small" onClick={() => update(day, [...s[day], EMPTY_BLOCK])}>
            + 新增時段
          </button>
        </div>
      ))}
    </div>
  );
}
