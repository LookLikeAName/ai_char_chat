// 匯出／匯入 avatar 的對話框
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { transferFileSchema, type AvatarDto, type TransferFile } from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { errorText, useToast } from '../lib/toast.tsx';
import { AvatarImage } from './AvatarImage.tsx';

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <h2>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

/** avatar 為 null 時匯出全部 */
export function ExportDialog({ avatar, onClose }: { avatar: AvatarDto | null; onClose: () => void }) {
  const [memories, setMemories] = useState(false);
  const [history, setHistory] = useState(false);
  const href = api.exportUrl(avatar?.id ?? null, { memories, history });
  return (
    <Dialog title={avatar ? `匯出 ${avatar.name}` : '匯出全部 avatar'} onClose={onClose}>
      <p className="hint">
        匯出成一個 JSON 檔，包含人格設定、頭像與這個 avatar 自己的參數；不包含 API key 與 LLM 設定檔，匯入時再選要綁定哪一個。
      </p>
      <label className="check">
        <input type="checkbox" checked={memories} onChange={(e) => setMemories(e.target.checked)} />
        記憶、印象、和你的關係與心情
      </label>
      <label className="check">
        <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
        一對一的聊天紀錄（最新的 5000 則）
      </label>
      {(memories || history) && <p className="hint">這些是你和它的私人內容，分享檔案前請留意。群組的紀錄不會匯出。</p>}
      <div className="row dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <a className="btn btn-primary" href={href} download onClick={() => setTimeout(onClose, 300)}>
          下載
        </a>
      </div>
    </Dialog>
  );
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: allProfiles = [] } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const profiles = allProfiles.filter((p) => p.kind === 'chat');
  const [file, setFile] = useState<TransferFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string>('');
  const [memories, setMemories] = useState(true);
  const [history, setHistory] = useState(true);
  // 預設用最多 avatar 綁定的設定檔
  const selectedProfile = profileId || [...profiles].sort((a, b) => b.usedBy - a.usedBy)[0]?.id || '';

  const hasMemories = !!file?.avatars.some((a) => a.memories?.length || a.relationship);
  const hasHistory = !!file?.avatars.some((a) => a.messages?.length);

  const read = async (f: File) => {
    setError(null);
    setFile(null);
    try {
      const parsed = transferFileSchema.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) throw new Error('這不是 avatar 匯出檔，或是版本不相容');
      setFile(parsed.data);
    } catch (err) {
      setError(err instanceof SyntaxError ? '檔案不是有效的 JSON' : (err as Error).message);
    }
  };

  const run = useMutation({
    mutationFn: () =>
      api.importAvatars({
        file: file!,
        profileId: selectedProfile || null,
        include: { memories: hasMemories && memories, history: hasHistory && history },
      }),
    onSuccess: async (res) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.avatars }),
        qc.invalidateQueries({ queryKey: qk.conversations }),
      ]);
      toast(`已匯入 ${res.avatars.map((a) => a.name).join('、')}`, 'success');
      if (res.avatars.length === 1) navigate(`/avatars/${res.avatars[0]!.id}`);
      onClose();
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <Dialog title="匯入 avatar" onClose={onClose}>
      <label className="field">
        <span className="field-label">匯出檔（.json）</span>
        <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} />
      </label>
      {error && <p className="warn-text">{error}</p>}
      {file && (
        <>
          <ul className="import-list">
            {file.avatars.map((a, i) => (
              <li key={i}>
                <AvatarImage name={a.name} src={a.image ? `data:${a.image.mime};base64,${a.image.data}` : null} size={32} />
                <span className="member-text">
                  <span className="member-name">{a.name}</span>
                  <span className="hint">
                    {[a.bio, a.memories?.length ? `${a.memories.length} 件記憶` : '', a.messages?.length ? `${a.messages.length} 則訊息` : '']
                      .filter(Boolean)
                      .join('・') || '（沒有簡介）'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <label className="field">
            <span className="field-label">大腦（LLM 設定檔）</span>
            <select value={selectedProfile} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.model}）
                </option>
              ))}
              <option value="">先不綁定</option>
            </select>
            <span className="hint">檔案裡原本調整過的參數（例如 temperature）會保留。</span>
          </label>
          {hasMemories && (
            <label className="check">
              <input type="checkbox" checked={memories} onChange={(e) => setMemories(e.target.checked)} />
              匯入記憶、印象與關係
            </label>
          )}
          {hasHistory && (
            <label className="check">
              <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
              匯入聊天紀錄
            </label>
          )}
          <p className="hint">每個都會建立成新的 avatar，不會覆蓋現有的。</p>
        </>
      )}
      <div className="row dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" disabled={!file || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? '匯入中…' : file ? `匯入 ${file.avatars.length} 個` : '匯入'}
        </button>
      </div>
    </Dialog>
  );
}
