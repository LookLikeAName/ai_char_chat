import { useState } from 'react';

/** 格式化的 JSON，太長時預設收合 */
export function JsonView({ value, collapsedOver = 1200 }: { value: unknown; collapsedOver?: number }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const long = text.length > collapsedOver;
  const [open, setOpen] = useState(!long);
  return (
    <div className="json-view">
      <div className="json-tools">
        <CopyButton text={text} />
        {long && (
          <button type="button" className="link-btn hint" onClick={() => setOpen((v) => !v)}>
            {open ? '收合' : `展開（${text.length.toLocaleString()} 字）`}
          </button>
        )}
      </div>
      <pre className={open ? '' : 'json-collapsed'}>{text}</pre>
    </div>
  );
}

export function CopyButton({ text, label = '複製' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? '已複製' : label}
    </button>
  );
}
