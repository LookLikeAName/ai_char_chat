import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  DEFAULT_BASE_URLS,
  defaultVision,
  KIND_PROVIDERS,
  MODEL_SUGGESTIONS,
  PROFILE_KIND_HINTS,
  PROFILE_KIND_LABELS,
  PROFILE_KINDS,
  PROVIDER_LABELS,
  utilityProfileIds,
  type AppSettings,
  type LlmParams,
  type LlmProfileDto,
  type LlmProfileInput,
  type ProfileKind,
  type ProviderType,
} from '@acc/shared';
import { TestResult } from '../../components/LlmBindingEditor.tsx';
import { Icon } from '../../components/Icon.tsx';
import { ParamEditor } from '../../components/ParamEditor.tsx';
import { api, qk, type LlmDraft, type LlmTestResult } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

/** 這個設定檔用在哪裡（列表上的標籤） */
function usageLabel(p: LlmProfileDto, settings: AppSettings | undefined): string | null {
  if (p.kind === 'chat') {
    const parts = [
      p.usedBy ? `${p.usedBy} 個 avatar 使用中` : '',
      settings && utilityProfileIds(settings).includes(p.id) ? '系統工具模型' : '',
    ];
    return parts.filter(Boolean).join('・') || null;
  }
  if (p.kind === 'image') return settings?.imageGen?.profileId === p.id ? '用在頭像與照片生成' : null;
  return settings?.embedding?.profileId === p.id ? '用在記憶' : null;
}

export function LlmProfilesSettings() {
  const { data: profiles = [], isLoading } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  // 從其他頁面連過來時可以帶 ?new=image 直接開新增表單
  const [params, setParams] = useSearchParams();
  const linked = params.get('new') as ProfileKind | null;
  const [selected, setSelected] = useState<string | 'new' | null>(linked && PROFILE_KINDS.includes(linked) ? 'new' : null);
  const [newKind, setNewKind] = useState<ProfileKind>(linked && PROFILE_KINDS.includes(linked) ? linked : 'chat');
  const current = profiles.find((p) => p.id === selected) ?? null;
  const done = (id: string | null) => {
    if (params.has('new')) setParams({}, { replace: true });
    setSelected(id);
  };

  if (selected === 'new' || current) {
    return <ProfileForm key={`${selected}-${newKind}`} profile={current} initialKind={newKind} onDone={done} />;
  }
  const add = (kind: ProfileKind) => {
    setNewKind(kind);
    setSelected('new');
  };

  return (
    <div className="editor">
      <header className="editor-head">
        <h1>LLM 設定檔</h1>
      </header>
      <p className="hint">
        在這裡統一設定供應商、API key 與模型。每個設定檔有一個用途：聊天用的給 avatar
        與系統工具模型綁定；圖片生成、記憶嵌入用的在「設定 → 一般」選。同一把 API key 可以建好幾個設定檔。
      </p>
      {isLoading && <p className="hint">載入中…</p>}
      {PROFILE_KINDS.map((kind) => {
        const list = profiles.filter((p) => p.kind === kind);
        return (
          <section key={kind} className="profile-group">
            <div className="profile-group-head">
              <h2>{PROFILE_KIND_LABELS[kind]}</h2>
              <button className="btn btn-small" onClick={() => add(kind)}>
                <Icon name="plus" size={14} /> 新增
              </button>
            </div>
            <p className="hint">{PROFILE_KIND_HINTS[kind]}</p>
            {list.length === 0 && !isLoading && (
              <p className="hint empty-line">
                {kind === 'chat'
                  ? '還沒有。例如新增一個「Gemini Flash」，供應商選 Google Gemini、填入 API key。'
                  : '還沒有（不設定也可以用，只是少了這個功能）。'}
              </p>
            )}
            <ul className="profile-list">
              {list.map((p) => {
                const usage = usageLabel(p, settings);
                return (
                  <li key={p.id}>
                    <button className="card profile-card" onClick={() => setSelected(p.id)}>
                      <span className="profile-name">{p.name}</span>
                      <span className="hint">
                        {PROVIDER_LABELS[p.provider]} · {p.model}
                      </span>
                      <span className="profile-meta">
                        <span className={p.hasApiKey ? 'tag' : 'tag tag-warn'}>
                          {p.hasApiKey ? `key ${p.apiKeyHint}` : '沒有 API key'}
                        </span>
                        {usage && <span className="tag">{usage}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

interface FormState {
  kind: ProfileKind;
  name: string;
  provider: ProviderType;
  baseUrl: string;
  model: string;
  /** 空字串表示不變更已存的 key */
  apiKey: string;
  clearKey: boolean;
  defaults: LlmParams;
  /** 美元／每 100 萬 tokens；兩個都空白表示不估算費用 */
  priceIn: string;
  priceOut: string;
  vision: 'auto' | 'yes' | 'no';
}

function ProfileForm({
  profile,
  initialKind,
  onDone,
}: {
  profile: LlmProfileDto | null;
  initialKind: ProfileKind;
  onDone: (id: string | null) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>({
    kind: profile?.kind ?? initialKind,
    name: profile?.name ?? '',
    provider: profile?.provider ?? 'google',
    baseUrl: profile?.baseUrl ?? '',
    model: profile?.model ?? '',
    apiKey: '',
    clearKey: false,
    defaults: profile?.defaults ?? { temperature: 0.9 },
    priceIn: profile?.pricing ? String(profile.pricing.input) : '',
    priceOut: profile?.pricing ? String(profile.pricing.output) : '',
    vision: !profile?.visionSet ? 'auto' : profile.vision ? 'yes' : 'no',
  });
  const [models, setModels] = useState<string[] | null>(null);
  const [test, setTest] = useState<LlmTestResult | { pending: true } | null>(null);
  const patch = (p: Partial<FormState>) => setF((prev) => ({ ...prev, ...p }));

  const chat = f.kind === 'chat';
  const input = (): LlmProfileInput => ({
    kind: f.kind,
    name: f.name,
    provider: f.provider,
    baseUrl: f.baseUrl.trim() || null,
    model: f.model,
    apiKey: f.apiKey.trim() ? f.apiKey.trim() : f.clearKey ? null : undefined,
    // 參數、看圖、價格只有聊天用得到
    defaults: chat ? f.defaults : {},
    pricing:
      chat && (f.priceIn.trim() || f.priceOut.trim())
        ? { input: Math.max(0, Number(f.priceIn) || 0), output: Math.max(0, Number(f.priceOut) || 0) }
        : null,
    vision: !chat || f.vision === 'auto' ? null : f.vision === 'yes',
  });

  const draft = (): LlmDraft => ({
    profileId: profile?.id,
    kind: f.kind,
    provider: f.provider,
    baseUrl: f.baseUrl.trim() || null,
    model: f.model,
    apiKey: f.apiKey.trim() || (f.clearKey ? null : undefined),
    params: f.defaults,
  });

  const save = useMutation({
    mutationFn: () => (profile ? api.updateLlmProfile(profile.id, input()) : api.createLlmProfile(input())),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: qk.llmProfiles });
      toast('設定檔已儲存', 'success');
      onDone(saved.id);
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteLlmProfile(profile!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.llmProfiles });
      toast('已刪除', 'success');
      onDone(null);
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const fetchModels = useMutation({
    mutationFn: () => api.listModels(draft()),
    onSuccess: (r) => {
      setModels(r.models);
      toast(`取得 ${r.models.length} 個模型`, 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const runTest = async () => {
    setTest({ pending: true });
    try {
      setTest(await api.testLlmDraft(draft()));
    } catch (err) {
      setTest({ ok: false, error: errorText(err), latencyMs: 0 });
    }
  };

  const defaultBase = DEFAULT_BASE_URLS[f.provider];

  return (
    <form
      className="editor"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <header className="editor-head">
        <button type="button" className="icon-btn" onClick={() => onDone(null)} aria-label="返回設定檔列表">
          <Icon name="back" />
        </button>
        <h1>{profile ? `編輯 ${profile.name}` : `新增${PROFILE_KIND_LABELS[f.kind]}用的設定檔`}</h1>
      </header>

      <section className="card">
        <h2>連線</h2>
        <label className="field">
          <span className="field-label">用途</span>
          <select
            value={f.kind}
            onChange={(e) => {
              const kind = e.target.value as ProfileKind;
              setModels(null);
              setTest(null);
              patch({ kind, provider: KIND_PROVIDERS[kind].includes(f.provider) ? f.provider : KIND_PROVIDERS[kind][0]! });
            }}
          >
            {PROFILE_KINDS.map((k) => (
              <option key={k} value={k}>
                {PROFILE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <span className="hint">{PROFILE_KIND_HINTS[f.kind]}</span>
        </label>
        <label className="field">
          <span className="field-label">名稱</span>
          <input value={f.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：Gemini Flash" required />
        </label>
        <label className="field">
          <span className="field-label">供應商</span>
          <select
            value={f.provider}
            onChange={(e) => {
              setModels(null);
              patch({ provider: e.target.value as ProviderType });
            }}
          >
            {KIND_PROVIDERS[f.kind].map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Base URL{defaultBase ? '（選填）' : ''}</span>
          <input
            value={f.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder={defaultBase ?? '例如 https://openrouter.ai/api/v1 或 http://ollama:11434/v1'}
            required={!defaultBase}
            type="url"
          />
        </label>
        <label className="field">
          <span className="field-label">API key</span>
          <input
            type="password"
            autoComplete="off"
            value={f.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value, clearKey: false })}
            placeholder={profile?.hasApiKey && !f.clearKey ? `已設定 ${profile.apiKeyHint}，留空表示不變更` : '貼上 API key'}
          />
          {profile?.hasApiKey && !f.apiKey && (
            <label className="check">
              <input type="checkbox" checked={f.clearKey} onChange={(e) => patch({ clearKey: e.target.checked })} />
              <span>清除已存的 key</span>
            </label>
          )}
          <span className="hint">key 加密後存在伺服器，不會再傳回瀏覽器。本機模型（Ollama 等）可以留空。</span>
        </label>
        <div className="field">
          <span className="field-label">模型</span>
          <div className="row">
            <input
              value={f.model}
              onChange={(e) => patch({ model: e.target.value })}
              list="model-options"
              placeholder={`例如 ${MODEL_SUGGESTIONS[f.kind][f.provider]?.[0] ?? (f.kind === 'chat' ? 'gemini-2.5-flash' : '')}`}
              required
              className="grow"
              aria-label="模型"
            />
            <button type="button" className="btn" onClick={() => fetchModels.mutate()} disabled={fetchModels.isPending}>
              {fetchModels.isPending ? '取得中…' : '取得模型清單'}
            </button>
          </div>
          <datalist id="model-options">
            {(models ?? MODEL_SUGGESTIONS[f.kind][f.provider] ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {f.kind === 'image' && (
            <span className="hint">模型名稱以 imagen 開頭的走 Imagen API，其他 Google 模型走 Gemini 的圖片輸出。</span>
          )}
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={runTest} disabled={!f.model || (!!test && 'pending' in test)}>
            {f.kind === 'image' ? '測試生成一張圖' : '測試連線'}
          </button>
          <TestResult result={test} />
        </div>
      </section>

      {chat && (
        <section className="card">
          <h2>參數預設值</h2>
          <p className="hint">綁定這個設定檔的 avatar 都會沿用這些值，avatar 可以各自覆寫。沒勾選的參數使用供應商預設。</p>
          <ParamEditor
            provider={f.provider}
            model={f.model}
            value={f.defaults}
            onChange={(defaults) => patch({ defaults })}
            inheritLabel=""
          />
        </section>
      )}

      {chat && (
        <section className="card">
          <h2>圖片</h2>
          <label className="field">
            <span className="field-label">看得懂圖片</span>
            <select value={f.vision} onChange={(e) => patch({ vision: e.target.value as FormState['vision'] })}>
              <option value="auto">依供應商預設（{defaultVision(f.provider) ? '看得懂' : '看不懂'}）</option>
              <option value="yes">看得懂</option>
              <option value="no">看不懂</option>
            </select>
            <span className="hint">
              看得懂的話，你傳的圖片會直接給 avatar 看；看不懂的話，改由系統工具模型（如果它看得懂）先寫一段描述。OpenAI
              相容端點要看模型，例如 Ollama 的 llava、qwen2.5-vl 看得懂。
            </span>
          </label>
        </section>
      )}

      {chat && (
        <section className="card">
          <h2>價格（選填）</h2>
          <p className="hint">填了之後，「設定 → 用量」會估算費用。單位是美元／每 100 萬 tokens，請照供應商的價目表填。</p>
          <div className="row">
            <label className="field">
              <span className="field-label">輸入</span>
              <input
                type="number"
                className="narrow-input"
                min={0}
                step={0.01}
                value={f.priceIn}
                placeholder="例如 0.3"
                onChange={(e) => patch({ priceIn: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">輸出</span>
              <input
                type="number"
                className="narrow-input"
                min={0}
                step={0.01}
                value={f.priceOut}
                placeholder="例如 2.5"
                onChange={(e) => patch({ priceOut: e.target.value })}
              />
            </label>
          </div>
        </section>
      )}

      <footer className="editor-foot">
        {profile && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (confirm(`確定要刪除「${profile.name}」嗎？`)) remove.mutate();
            }}
          >
            <Icon name="trash" size={16} /> 刪除
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? '儲存中…' : '儲存'}
        </button>
      </footer>
    </form>
  );
}
