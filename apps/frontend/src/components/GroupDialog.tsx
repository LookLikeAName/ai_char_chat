// 建立／編輯群組：名稱 + 勾選成員（2～8 個 avatar）
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { shownName } from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { errorText, useToast } from '../lib/toast.tsx';
import { AvatarImage } from './AvatarImage.tsx';

const MAX_MEMBERS = 8;

export function GroupDialog({
  group,
  onClose,
}: {
  /** 有值時是編輯 */
  group?: { id: string; title: string; memberAvatarIds: string[] };
  onClose: () => void;
}) {
  const { data: avatars = [] } = useQuery({ queryKey: qk.avatars, queryFn: api.avatars });
  const [title, setTitle] = useState(group?.title ?? '');
  const [selected, setSelected] = useState<string[]>(group?.memberAvatarIds ?? []);
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const save = useMutation({
    mutationFn: async () => {
      // 沒取名時用成員名字
      const name =
        title.trim() ||
        selected
          .map((id) => {
            const a = avatars.find((x) => x.id === id);
            return a ? shownName(a) : '';
          })
          .filter(Boolean)
          .join('、')
          .slice(0, 40);
      const input = { title: name, avatarIds: selected };
      if (group) {
        await api.updateGroup(group.id, input);
        return group.id;
      }
      return (await api.createGroup(input)).id;
    },
    onSuccess: async (id) => {
      await qc.invalidateQueries({ queryKey: qk.conversations });
      if (!group) navigate(`/chats/${id}`);
      onClose();
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < MAX_MEMBERS ? [...cur, id] : cur));

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="group-dialog-title"
      onClose={onClose}
      onClick={(e) => {
        // 點到背景就關閉
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 id="group-dialog-title">{group ? '編輯群組' : '建立群組'}</h2>
        <label className="field">
          <span className="field-label">群組名稱</span>
          <input
            value={title}
            maxLength={40}
            placeholder="不填的話用成員名字"
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <fieldset className="field member-picker">
          <legend className="field-label">
            成員 <span className="hint">（{selected.length}／{MAX_MEMBERS}，至少 2 位）</span>
          </legend>
          {avatars.length < 2 && <p className="hint">至少要有 2 個 avatar 才能建立群組。</p>}
          <p className="hint">沒有設成「相關的角色」的成員彼此一開始不認識，會在群組裡聊著聊著慢慢熟起來。</p>
          <ul>
            {avatars.map((a) => (
              <li key={a.id}>
                <label className="check member-option">
                  <input
                    type="checkbox"
                    checked={selected.includes(a.id)}
                    disabled={!selected.includes(a.id) && selected.length >= MAX_MEMBERS}
                    onChange={() => toggle(a.id)}
                  />
                  <AvatarImage name={shownName(a)} src={a.imageUrl} size={28} />
                  <span>{shownName(a)}</span>
                  {!a.llm && <span className="hint">（沒有綁定 LLM，不會說話）</span>}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        {group && <p className="hint">新成員從現在開始參與：看得到之前的聊天紀錄，但不會回覆加入前的訊息。</p>}
        <div className="row dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={selected.length < 2 || save.isPending}>
            {save.isPending ? '儲存中…' : group ? '儲存' : '建立'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
