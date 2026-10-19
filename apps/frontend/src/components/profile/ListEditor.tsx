import { useState } from 'react';

/** 字串清單：輸入後按 Enter 加入，點 × 移除 */
export function ListEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="list-input">
      {value.map((item) => (
        <span key={item} className="chip">
          {item}
          <button type="button" aria-label={`移除 ${item}`} onClick={() => onChange(value.filter((x) => x !== item))}>
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={value.length ? '再加一項，按 Enter' : placeholder}
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
