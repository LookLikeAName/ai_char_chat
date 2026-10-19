import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  defaultImagePrompt,
  IMAGE_STYLE_LABELS,
  isPersonaEmpty,
  missingFields,
  DEFAULT_AVATAR_PHOTO,
  type AvatarDto,
  type AvatarInput,
  type AvatarPhoto,
  type ImageStyle,
  type InitialStage,
  type LlmBinding,
  INITIAL_STAGES,
  STAGE_LABELS,
} from '@acc/shared';
import { AvatarImage } from '../../components/AvatarImage.tsx';
import { Icon } from '../../components/Icon.tsx';
import { LlmBindingEditor } from '../../components/LlmBindingEditor.tsx';
import { PhotoSettingsCard } from '../../components/PhotoSettingsCard.tsx';
import { ExportDialog } from '../../components/TransferDialogs.tsx';
import { PersonaEditor, type PersonaState } from '../../components/persona/PersonaEditor.tsx';
import { api, qk } from '../../lib/api.ts';
import { deepEqual } from '../../lib/equal.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

type Tab = 'basic' | 'persona' | 'brain';
const TABS: { key: Tab; label: string }[] = [
  { key: 'basic', label: '基本資料' },
  { key: 'persona', label: '人格設定' },
  { key: 'brain', label: '大腦（LLM）' },
];

export function AvatarEditor({ avatar }: { avatar: AvatarDto | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>(avatar ? 'basic' : 'persona');
  const [p, setP] = useState<PersonaState>({
    name: avatar?.name ?? '',
    bio: avatar?.bio ?? '',
    persona: avatar?.persona ?? {},
    locks: avatar?.personaLocks ?? [],
  });
  const [llm, setLlm] = useState<LlmBinding | null>(avatar?.llm ?? null);
  const [initialStage, setInitialStage] = useState<InitialStage>('stranger');
  const [exporting, setExporting] = useState(false);
  const [photo, setPhoto] = useState<AvatarPhoto>(avatar?.photo ?? DEFAULT_AVATAR_PHOTO);
  const [tokenLimit, setTokenLimit] = useState(avatar?.dailyTokenLimit ?? 0);

  const empty = isPersonaEmpty(p.persona);
  const missing = empty ? [] : missingFields(p.persona);
  const dirty =
    !!avatar &&
    (p.name !== avatar.name ||
      p.bio !== avatar.bio ||
      !deepEqual(llm, avatar.llm) ||
      tokenLimit !== avatar.dailyTokenLimit ||
      !deepEqual(photo, avatar.photo) ||
      !deepEqual(p.persona, avatar.persona) ||
      !deepEqual([...p.locks].sort(), [...avatar.personaLocks].sort()));

  const save = useMutation({
    mutationFn: (input: AvatarInput) => (avatar ? api.updateAvatar(avatar.id, input) : api.createAvatar(input)),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: qk.avatars });
      void qc.invalidateQueries({ queryKey: qk.llmProfiles });
      toast(avatar ? '已儲存' : `已建立 ${saved.name}`, 'success');
      if (!avatar) navigate(`/avatars/${saved.id}`, { replace: true });
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteAvatar(avatar!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.avatars });
      toast('已刪除', 'success');
      navigate('/avatars', { replace: true });
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const canSave = !!p.name.trim() && missing.length === 0 && !save.isPending;

  return (
    <form
      className="editor editor-wide"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) {
          save.mutate({
            name: p.name,
            bio: p.bio,
            llm,
            persona: p.persona,
            personaLocks: p.locks,
            dailyTokenLimit: tokenLimit,
            photo,
            ...(avatar ? {} : { initialStage }),
          });
        }
      }}
    >
      <header className="editor-head">
        <Link to="/avatars" className="icon-btn only-narrow" aria-label="返回列表">
          <Icon name="back" />
        </Link>
        <h1>{avatar ? `編輯 ${avatar.name}` : '新增 avatar'}</h1>
        {avatar && (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setExporting(true)}>
              <Icon name="download" size={16} /> 匯出
            </button>
            <Link className="btn" to={`/chats/${avatar.dmConversationId}`}>
              <Icon name="chat" size={16} /> 聊天
            </Link>
          </>
        )}
      </header>
      {exporting && avatar && <ExportDialog avatar={avatar} onClose={() => setExporting(false)} />}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === 'persona' && missing.length > 0 && <span className="tab-dot" aria-label="有未填欄位" />}
            {t.key === 'brain' && !llm && <span className="tab-dot" aria-label="尚未設定" />}
          </button>
        ))}
      </div>

      {tab === 'basic' && (
        <>
          <section className="card">
            <h2>名字與簡介</h2>
            <label className="field">
              <span className="field-label">名字</span>
              <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} maxLength={40} required />
            </label>
            <label className="field">
              <span className="field-label">簡介</span>
              <textarea value={p.bio} onChange={(e) => setP({ ...p, bio: e.target.value })} maxLength={500} rows={3} />
              <span className="hint">一句話描述這個角色。人格設定空著時，avatar 只依簡介行動。</span>
            </label>
            {!avatar && (
              <label className="field">
                <span className="field-label">和你的初始關係</span>
                <select value={initialStage} onChange={(e) => setInitialStage(e.target.value as InitialStage)}>
                  {INITIAL_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
                <span className="hint">決定一開始的好感與信任；建立後可以在聊天畫面的資訊面板重設。</span>
              </label>
            )}
          </section>
          <AvatarImageCard avatar={avatar} state={p} />
          <PhotoSettingsCard avatar={avatar} value={photo} onChange={setPhoto} />
        </>
      )}

      {tab === 'persona' && <PersonaEditor value={p} onChange={setP} />}

      {tab === 'brain' && (
        <section className="card">
          <h2>大腦（LLM）</h2>
          <p className="hint">
            選一個在設定頁建立的 LLM 設定檔。供應商、模型、API key 在設定檔統一管理，這裡只調整這個 avatar 自己的參數。
          </p>
          <LlmBindingEditor value={llm} onChange={setLlm} />
          <label className="field">
            <span className="field-label">每日 token 上限（0 表示不限）</span>
            <input
              type="number"
              className="narrow-input"
              min={0}
              step={1000}
              value={tokenLimit}
              onChange={(e) => setTokenLimit(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            />
            <span className="hint">
              包含回覆、主動發話、整理它的記憶與生活日誌。超過之後它今天不再回覆，隔天自動恢復。全部加起來的上限在「設定 → 一般 → 費用」。
            </span>
          </label>
        </section>
      )}

      <footer className="editor-foot">
        {avatar && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (confirm(`確定要刪除「${avatar.name}」嗎？它的一對一聊天紀錄也會一起刪除。`)) remove.mutate();
            }}
          >
            <Icon name="trash" size={16} /> 刪除
          </button>
        )}
        <span className="spacer" />
        {missing.length > 0 ? (
          <span className="hint warn-text">
            人格設定還有 {missing.length} 個欄位沒填
            {tab !== 'persona' && (
              <>
                ，
                <button type="button" className="link-btn" onClick={() => setTab('persona')}>
                  去補完
                </button>
              </>
            )}
          </span>
        ) : (
          avatar && dirty && <span className="hint">有尚未儲存的變更</span>
        )}
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {save.isPending ? '儲存中…' : avatar ? '儲存' : '建立'}
        </button>
      </footer>
    </form>
  );
}

function AvatarImageCard({ avatar, state }: { avatar: AvatarDto | null; state: PersonaState }) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const [style, setStyle] = useState<ImageStyle>('anime');
  const [prompt, setPrompt] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: qk.avatars });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadAvatarImage(avatar!.id, file),
    onSuccess: refresh,
    onError: (err) => toast(errorText(err), 'error'),
  });
  const removeImage = useMutation({
    mutationFn: () => api.deleteAvatarImage(avatar!.id),
    onSuccess: refresh,
    onError: (err) => toast(errorText(err), 'error'),
  });
  const generate = useMutation({
    mutationFn: (text: string) => api.generateAvatarImage(avatar!.id, text),
    onSuccess: () => {
      refresh();
      toast('頭像已生成', 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const basePrompt = defaultImagePrompt(state.name || '角色', state.persona, style);

  return (
    <section className="card">
      <h2>頭像</h2>
      <div className="avatar-row">
        <AvatarImage name={state.name || '?'} src={avatar?.imageUrl ?? null} size={96} />
        <div className="avatar-row-actions">
          {avatar ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = '';
                }}
              />
              <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                <Icon name="image" size={16} /> {upload.isPending ? '上傳中…' : '上傳圖片'}
              </button>
              {avatar.imageUrl && (
                <button type="button" className="btn btn-ghost" onClick={() => removeImage.mutate()}>
                  移除
                </button>
              )}
              <span className="hint">PNG、JPEG、WebP、GIF，5 MB 以內。</span>
            </>
          ) : (
            <span className="hint">建立後就可以上傳或生成頭像。</span>
          )}
        </div>
      </div>

      {avatar && (
        <details className="image-gen">
          <summary>用 AI 生成頭像</summary>
          {!settings?.imageGen ? (
            <p className="hint">
              先到 <Link to="/settings/general">設定 → 一般 → 頭像生成</Link> 選擇圖片模型。
            </p>
          ) : (
            <>
              <label className="field">
                <span className="field-label">畫風</span>
                <select
                  value={style}
                  onChange={(e) => {
                    setStyle(e.target.value as ImageStyle);
                    setPrompt(null);
                  }}
                >
                  {Object.entries(IMAGE_STYLE_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">提示詞</span>
                <textarea rows={6} value={prompt ?? basePrompt} onChange={(e) => setPrompt(e.target.value)} />
                <span className="hint">依人格設定的外貌與穿著自動產生，可以直接修改。生成的圖片會取代目前的頭像。</span>
              </label>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={generate.isPending}
                  onClick={() => generate.mutate(prompt ?? basePrompt)}
                >
                  {generate.isPending ? '生成中…' : '生成'}
                </button>
                {prompt !== null && (
                  <button type="button" className="btn btn-ghost" onClick={() => setPrompt(null)}>
                    還原提示詞
                  </button>
                )}
              </div>
            </>
          )}
        </details>
      )}
    </section>
  );
}
