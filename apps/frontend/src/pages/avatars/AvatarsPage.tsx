import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { AvatarDto, AvatarInput, LlmBinding } from '@acc/shared';
import { AvatarImage } from '../../components/AvatarImage.tsx';
import { Icon } from '../../components/Icon.tsx';
import { LlmBindingEditor } from '../../components/LlmBindingEditor.tsx';
import { api, qk } from '../../lib/api.ts';
import { deepEqual } from '../../lib/equal.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function AvatarsPage() {
  const { avatarId } = useParams();
  const { data: avatars = [], isLoading } = useQuery({ queryKey: qk.avatars, queryFn: api.avatars });
  const current = avatars.find((a) => a.id === avatarId);
  const isNew = avatarId === 'new';

  return (
    <div className={`two-pane${avatarId ? ' has-selection' : ''}`}>
      <aside className="chat-list" aria-label="Avatar 列表">
        <div className="chat-list-head">
          <h1 className="pane-title">Avatar</h1>
          <Link to="/avatars/new" className="icon-btn" title="新增 avatar" aria-label="新增 avatar">
            <Icon name="plus" />
          </Link>
        </div>
        <div className="chat-list-scroll">
          {isLoading && <p className="hint pad">載入中…</p>}
          {!isLoading && avatars.length === 0 && <p className="hint pad">還沒有 avatar，按右上角的 + 新增。</p>}
          {avatars.map((a) => (
            <Link key={a.id} to={`/avatars/${a.id}`} className={`chat-item${a.id === avatarId ? ' active' : ''}`}>
              <AvatarImage name={a.name} src={a.imageUrl} size={44} />
              <span className="chat-item-body">
                <span className="chat-item-title">{a.name}</span>
                <span className="chat-item-preview">{a.bio || '（沒有簡介）'}</span>
              </span>
            </Link>
          ))}
        </div>
      </aside>
      <main className="pane-main">
        {isNew ? (
          <AvatarEditor key="new" avatar={null} />
        ) : current ? (
          <AvatarEditor key={current.id} avatar={current} />
        ) : avatarId && !isLoading ? (
          <p className="hint pad">找不到這個 avatar。</p>
        ) : (
          <div className="chat-empty">
            <Icon name="avatar" size={40} />
            <p>選一個 avatar 編輯，或新增一個</p>
          </div>
        )}
      </main>
    </div>
  );
}

function AvatarEditor({ avatar }: { avatar: AvatarDto | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(avatar?.name ?? '');
  const [bio, setBio] = useState(avatar?.bio ?? '');
  const [llm, setLlm] = useState<LlmBinding | null>(avatar?.llm ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty =
    !!avatar && (name !== avatar.name || bio !== avatar.bio || !deepEqual(llm, avatar.llm));

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

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadAvatarImage(avatar!.id, file),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.avatars }),
    onError: (err) => toast(errorText(err), 'error'),
  });

  const removeImage = useMutation({
    mutationFn: () => api.deleteAvatarImage(avatar!.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.avatars }),
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <form
      className="editor"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ name, bio, llm });
      }}
    >
      <header className="editor-head">
        <Link to="/avatars" className="icon-btn only-narrow" aria-label="返回列表">
          <Icon name="back" />
        </Link>
        <h1>{avatar ? `編輯 ${avatar.name}` : '新增 avatar'}</h1>
        {avatar && (
          <Link className="btn" to={`/chats/${avatar.dmConversationId}`}>
            <Icon name="chat" size={16} /> 聊天
          </Link>
        )}
      </header>

      <section className="card">
        <h2>基本資料</h2>
        <div className="avatar-row">
          <AvatarImage name={name || '?'} src={avatar?.imageUrl ?? null} size={88} />
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
                  <Icon name="image" size={16} /> {upload.isPending ? '上傳中…' : '上傳頭像'}
                </button>
                {avatar.imageUrl && (
                  <button type="button" className="btn btn-ghost" onClick={() => removeImage.mutate()}>
                    移除頭像
                  </button>
                )}
                <span className="hint">PNG、JPEG、WebP、GIF，5 MB 以內。AI 生成頭像在第 3 階段加入。</span>
              </>
            ) : (
              <span className="hint">建立後就可以上傳頭像。</span>
            )}
          </div>
        </div>
        <label className="field">
          <span className="field-label">名字</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        </label>
        <label className="field">
          <span className="field-label">簡介</span>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} rows={3} />
          <span className="hint">完整的人格設定（思考方式、價值觀、作息…）在第 3 階段的 avatar creator 加入。</span>
        </label>
      </section>

      <section className="card">
        <h2>大腦（LLM）</h2>
        <p className="hint">
          選一個在設定頁建立的 LLM 設定檔。供應商、模型、API key 在設定檔統一管理，這裡只調整這個 avatar 自己的參數。
        </p>
        <LlmBindingEditor value={llm} onChange={setLlm} />
      </section>

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
        {avatar && dirty && <span className="hint">有尚未儲存的變更</span>}
        <button type="submit" className="btn btn-primary" disabled={save.isPending || !name.trim()}>
          {save.isPending ? '儲存中…' : avatar ? '儲存' : '建立'}
        </button>
      </footer>
    </form>
  );
}
