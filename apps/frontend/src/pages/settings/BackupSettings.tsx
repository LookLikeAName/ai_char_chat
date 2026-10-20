// 備份：匯出／匯入一般設定、LLM 設定檔與玩家 profile；avatar 在 Avatar 列表另外匯出
import { useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { settingsFileSchema, type SettingsFile, type SettingsImportResultDto } from '@acc/shared';
import { api, qk } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function BackupSettings() {
  return (
    <div className="editor">
      <header className="editor-head">
        <h1>備份</h1>
      </header>
      <ExportCard />
      <ImportCard />
    </div>
  );
}

function ExportCard() {
  const [apiKeys, setApiKeys] = useState(false);
  const [player, setPlayer] = useState(false);
  return (
    <section className="card">
      <h2>匯出設定</h2>
      <p className="hint">
        一般設定（時區、勿擾時段、系統工具模型、照片…）與所有 LLM 設定檔，存成一個 JSON 檔，可以搬到另一台或當作備份。avatar
        另外在 <Link to="/avatars">Avatar 列表</Link> 匯出。登入密碼不會匯出。
      </p>
      <label className="check">
        <input type="checkbox" checked={apiKeys} onChange={(e) => setApiKeys(e.target.checked)} />
        包含 API key
      </label>
      {apiKeys && <p className="hint warn-text">API key 會以明碼寫在檔案裡，請不要分享這個檔案，用完記得妥善保存或刪除。</p>}
      <label className="check">
        <input type="checkbox" checked={player} onChange={(e) => setPlayer(e.target.checked)} />
        包含我的 profile（偏好問卷、測驗作答與摘要）
      </label>
      <div className="row">
        <a className="btn btn-primary" href={api.settingsExportUrl({ apiKeys, player })} download>
          下載
        </a>
      </div>
    </section>
  );
}

function ImportCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<SettingsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [include, setInclude] = useState({ settings: true, profiles: true, player: true });
  const [result, setResult] = useState<SettingsImportResultDto | null>(null);

  const read = async (f: File) => {
    setError(null);
    setFile(null);
    setResult(null);
    try {
      const parsed = settingsFileSchema.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) throw new Error('這不是設定的匯出檔，或是版本不相容');
      setFile(parsed.data);
    } catch (err) {
      setError(err instanceof SyntaxError ? '檔案不是有效的 JSON' : (err as Error).message);
    }
  };

  const run = useMutation({
    mutationFn: () => api.importSettings({ file: file!, include: { ...include, player: include.player && !!file?.player } }),
    onSuccess: async (r) => {
      setResult(r);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.settings }),
        qc.invalidateQueries({ queryKey: qk.llmProfiles }),
        qc.invalidateQueries({ queryKey: qk.profile }),
      ]);
      toast('已匯入', 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const keys = file?.profiles.filter((p) => p.apiKey).length ?? 0;
  const toggle = (k: keyof typeof include) => (e: ChangeEvent<HTMLInputElement>) => setInclude({ ...include, [k]: e.target.checked });

  return (
    <section className="card">
      <h2>匯入設定</h2>
      <label className="field">
        <span className="field-label">設定的匯出檔（.json）</span>
        <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} />
      </label>
      {error && <p className="warn-text">{error}</p>}
      {file && (
        <>
          <p className="hint">
            {new Date(file.exportedAt).toLocaleString('zh-TW')} 匯出：{file.profiles.length} 個 LLM 設定檔
            {keys ? `（${keys} 個有 API key）` : '（沒有 API key）'}
            {file.player ? '、玩家 profile' : ''}。
          </p>
          <label className="check">
            <input type="checkbox" checked={include.settings} onChange={toggle('settings')} />
            一般設定（會取代目前的設定）
          </label>
          <label className="check">
            <input type="checkbox" checked={include.profiles} onChange={toggle('profiles')} />
            LLM 設定檔（和現有一樣的會沿用，其他的新增）
          </label>
          {file.player && (
            <label className="check">
              <input type="checkbox" checked={include.player} onChange={toggle('player')} />
              玩家 profile（會取代目前的問卷、作答與摘要）
            </label>
          )}
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={run.isPending || !Object.values(include).some(Boolean)} onClick={() => run.mutate()}>
              {run.isPending ? '匯入中…' : '匯入'}
            </button>
          </div>
        </>
      )}
      {result && (
        <div className="import-result" role="status">
          <p>
            LLM 設定檔：新增 {result.profiles.created} 個、沿用 {result.profiles.reused} 個
            {result.profiles.keys ? `，寫入 ${result.profiles.keys} 個 API key` : ''}
            {result.settings ? '；已套用一般設定' : ''}
            {result.player ? '；已匯入玩家 profile' : ''}。
          </p>
          {result.warnings.length > 0 && (
            <ul className="warn-text">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {!keys && result.profiles.created > 0 && (
            <p className="hint">
              檔案裡沒有 API key：到 <Link to="/settings/llm">LLM 設定檔</Link> 替新增的設定檔填上 key。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
