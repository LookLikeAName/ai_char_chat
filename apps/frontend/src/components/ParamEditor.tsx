// LLM 參數編輯：每個參數可以「指定值」或「沿用上一層」（設定檔 → 供應商預設；綁定 → 設定檔）
import { PARAM_SPECS, type LlmParamKey, type LlmParams, type ProviderType } from '@acc/shared';

interface Props {
  provider: ProviderType | null;
  value: LlmParams;
  onChange: (next: LlmParams) => void;
  /** 沒有指定時沿用的值；undefined 表示供應商預設 */
  inherited?: LlmParams;
  inheritLabel: string;
}

const FALLBACK: Record<LlmParamKey, number> = {
  temperature: 0.9,
  topP: 0.95,
  maxOutputTokens: 1024,
  presencePenalty: 0,
  frequencyPenalty: 0,
};

export function ParamEditor({ provider, value, onChange, inherited = {}, inheritLabel }: Props) {
  const set = (key: LlmParamKey, v: number | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

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
    </div>
  );
}
