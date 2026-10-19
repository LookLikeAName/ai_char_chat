// 量表作答：每題一列，點選即存（可以隨時離開，下次接著做）。
import { useRef } from 'react';
import type { Answers, Instrument } from '@acc/shared';

interface Props {
  instrument: Instrument;
  answers: Answers;
  onAnswer: (itemId: string, value: number) => void;
}

export function Questionnaire({ instrument, answers, onAnswer }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const { min, max, labels } = instrument.scale;
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const answered = instrument.items.filter((i) => answers[i.id] !== undefined).length;

  const answer = (itemId: string, v: number, index: number) => {
    const first = answers[itemId] === undefined;
    onAnswer(itemId, v);
    // 第一次回答時捲到下一題還沒答的題目
    if (first) {
      const next = instrument.items.findIndex((it, j) => j > index && answers[it.id] === undefined);
      if (next >= 0) {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-item="${instrument.items[next]!.id}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  return (
    <div className="questionnaire">
      <header className="q-head">
        <h2>{instrument.title}</h2>
        <p>{instrument.about}</p>
        <p className="hint">{instrument.citation}</p>
        <p className="q-instructions">{instrument.instructions}</p>
        <div className="q-progress">
          <div className="progress-bar">
            <span style={{ width: `${(answered / instrument.items.length) * 100}%` }} />
          </div>
          <span className="hint">
            {answered} / {instrument.items.length}
          </span>
        </div>
      </header>
      <ol className="q-items" ref={listRef}>
        {instrument.items.map((item, idx) => {
          const v = answers[item.id];
          return (
            <li key={item.id} className={`q-item${v !== undefined ? ' done' : ''}`} data-item={item.id}>
              <p className="q-text" id={`q-${item.id}`}>
                {item.text}
              </p>
              <div className="likert" role="radiogroup" aria-labelledby={`q-${item.id}`}>
                {values.map((val, i) => (
                  <button
                    key={val}
                    type="button"
                    role="radio"
                    aria-checked={v === val}
                    aria-label={labels[i]}
                    title={labels[i]}
                    className={`likert-opt${v === val ? ' selected' : ''}`}
                    onClick={() => answer(item.id, val, idx)}
                  >
                    <span className="likert-dot" />
                  </button>
                ))}
              </div>
              <div className="likert-ends" aria-hidden>
                <span>{labels[0]}</span>
                <span className="likert-current">{v !== undefined ? labels[v - min] : ''}</span>
                <span>{labels[labels.length - 1]}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
