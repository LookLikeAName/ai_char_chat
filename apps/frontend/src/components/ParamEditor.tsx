// LLM 參數編輯：每個參數可以「指定值」或「沿用上一層」（設定檔 → 供應商預設；綁定 → 設定檔）
import {
  geminiThinkingConfig,
  PARAM_SPECS,
  THINKING_SPEC,
  type LlmParams,
  type NumericParamKey,
  type ProviderType,
  type ThinkingLevel,
} from '@acc/shared';

interface Props {
  provider: ProviderType | null;
  /** 模型名稱：思考程度要看是哪一代的 Gemini */
  model?: string;
  value: LlmParams;
  onChange: (next: LlmParams) => void;
  /** 沒有指定時沿用的值；undefined 表示供應商預設 */
  inherited?: LlmParams;
  inheritLabel: string;
}

const FALLBACK: Record<NumericParamKey, number> = {
  temperature: 0.9,
  topP: 0.95,
  maxOutputTokens: 1024,
  presencePenalty: 0,
  frequencyPenalty: 0,
};

/** 送給 Gemini 的實際設定，讓使用者知道選的等級對這個模型代表什麼 */
function thinkingNote(model: string | undefined, level: ThinkingLevel): string {
  if (!model) return '';
  const c = geminiThinkingConfig(model, level);
  if (!c) {
    if (level === 'auto' && /^(models\/)?gemini-/.test(model) && !/gemini-(1\.|2\.0)/.test(model)) return '不另外設定，用模型預設的思考程度';
    return '這個模型不支援調整思考，會略過';
  }
  return 'thinkingLevel' in c
    ? `送出 thinkingLevel: ${c.thinkingLevel}`
    : `送出 thinkingBudget: ${c.thinkingBudget}${c.thinkingBudget === 0 ? '（不思考）' : c.thinkingBudget < 0 ? '（動態）' : ' tokens'}`;
}

export function ParamEditor({ provider, model, value, onChange, inherited = {}, inheritLabel }: Props) {
  const set = <K extends keyof LlmParams>(key: K, v: LlmParams[K] | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const thinking = THINKING_SPEC;
  const thinkingSupported = !provider || thinking.providers.includes(provider);
  const ownThinking = value.thinking;
  const inheritedThinking = inherited.thinking;

  return (
    <div className="params">
      {PARAM_SPECS.map((spec) => {
        const supported = !provider || spec.providers.includes(provider);
        const own = value[spec.key];
        const overridden = own !== undefined;
        const inheritedValue = inherited[spec.key];
        const shown = own ?? inheritedValue ?? FALLBACK[spec.key];
        const isInt = spec.step >= 1;
        return (
          <div key={spec.key} className={`param-row${supported ? '' : ' param-unsupported'}`}>
            <label className="param-toggle">
              <input
                type="checkbox"
                checked={overridden}
                disabled={!supported}
                onChange={(e) => set(spec.key, e.target.checked ? shown : undefined)}
              />
              <span>{spec.label}</span>
            </label>
            {overridden ? (
              <div className="param-control">
                {!isInt && (
                  <input
                    type="range"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    value={own}
                    onChange={(e) => set(spec.key, Number(e.target.value))}
                    aria-label={spec.label}
                  />
                )}
                <input
                  type="number"
                  className="param-number"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={own}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (e.target.value !== '' && Number.isFinite(n)) set(spec.key, isInt ? Math.round(n) : n);
                  }}
                  aria-label={`${spec.label} 數值`}
                />
              </div>
            ) : (
              <span className="param-inherit">
                {!supported
                  ? '這個供應商不支援'
                  : inheritedValue !== undefined
                    ? `${inheritLabel}：${inheritedValue}`
                    : '供應商預設'}
              </span>
            )}
          </div>
        );
      })}
      <div className={`param-row${thinkingSupported ? '' : ' param-unsupported'}`}>
        <label className="param-toggle">
          <input
            type="checkbox"
            checked={ownThinking !== undefined}
            disabled={!thinkingSupported}
            onChange={(e) => set('thinking', e.target.checked ? (inheritedThinking ?? 'low') : undefined)}
          />
          <span>{thinking.label}</span>
        </label>
        {ownThinking !== undefined ? (
          <div className="param-control param-choice">
            <select value={ownThinking} onChange={(e) => set('thinking', e.target.value as ThinkingLevel)} aria-label={thinking.label}>
              {thinking.options.map((o) => (
                <option key={o} value={o}>
                  {thinking.labels[o]}
                </option>
              ))}
            </select>
            <span className="hint">
              {thinkingNote(model, ownThinking)}
              {ownThinking !== 'minimal' && '。思考用掉的 tokens 也算輸出用量，回覆會比較慢；聊天通常用「最少」或「低」就夠了'}
            </span>
          </div>
        ) : (
          <span className="param-inherit">
            {!thinkingSupported
              ? '只有 Google Gemini 支援'
              : inheritedThinking !== undefined
                ? `${inheritLabel}：${thinking.labels[inheritedThinking]}`
                : '供應商預設'}
          </span>
        )}
      </div>
    </div>
  );
}
