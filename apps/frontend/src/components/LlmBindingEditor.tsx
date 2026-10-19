// 綁定 LLM 設定檔，並只覆寫需要調整的參數。avatar 設定頁與系統工具模型共用。
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PROVIDER_LABELS, resolveParams, type LlmBinding } from '@acc/shared';
import { api, qk, type LlmTestResult } from '../lib/api.ts';
import { errorText } from '../lib/toast.tsx';
import { ParamEditor } from './ParamEditor.tsx';

interface Props {
  value: LlmBinding | null;
  onChange: (next: LlmBinding | null) => void;
  allowNone?: boolean;
}

export function LlmBindingEditor({ value, onChange, allowNone = true }: Props) {
  const { data: profiles = [], isLoading } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const [test, setTest] = useState<LlmTestResult | { pending: true } | null>(null);
  const profile = profiles.find((p) => p.id === value?.profileId) ?? null;

  if (!isLoading && profiles.length === 0) {
    return (
      <p className="hint">
        還沒有任何 LLM 設定檔。請先到 <Link to="/settings/llm">設定 → LLM 設定檔</Link> 新增一個。
      </p>
    );
  }

  const runTest = async () => {
    if (!value) return;
    setTest({ pending: true });
    try {
      setTest(await api.testLlmProfile(value.profileId, value.params));
    } catch (err) {
      setTest({ ok: false, error: errorText(err), latencyMs: 0 });
    }
  };

  return (
    <div className="binding">
      <label className="field">
        <span className="field-label">LLM 設定檔</span>
        <select
          value={value?.profileId ?? ''}
          onChange={(e) => {
            setTest(null);
            onChange(e.target.value ? { profileId: e.target.value, params: value?.params ?? {} } : null);
          }}
        >
          {allowNone && <option value="">（未設定）</option>}
          {!allowNone && !value && <option value="">請選擇…</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{PROVIDER_LABELS[p.provider]} · {p.model}）
            </option>
          ))}
        </select>
      </label>

      {value && profile && (
        <>
          <p className="hint">勾選的參數會覆寫設定檔的值；沒勾選的沿用設定檔「{profile.name}」。</p>
          <ParamEditor
            provider={profile.provider}
            model={profile.model}
            value={value.params}
            onChange={(params) => onChange({ ...value, params })}
            inherited={profile.defaults}
            inheritLabel="沿用設定檔"
          />
          <div className="row">
            <button type="button" className="btn" onClick={runTest} disabled={!!test && 'pending' in test}>
              用這組參數測試
            </button>
            <TestResult result={test} />
          </div>
          <details className="effective">
            <summary>實際送出的參數</summary>
            <code>{JSON.stringify(resolveParams(profile.defaults, value.params))}</code>
          </details>
        </>
      )}
    </div>
  );
}

export function TestResult({ result }: { result: LlmTestResult | { pending: true } | null }) {
  if (!result) return null;
  if ('pending' in result) return <span className="test-result">測試中…</span>;
  if (!result.ok) return <span className="test-result test-fail">失敗：{result.error}</span>;
  return (
    <span className="test-result test-ok">
      成功（{(result.latencyMs / 1000).toFixed(1)} 秒）：{result.reply || '（空白回應）'}
    </span>
  );
}
