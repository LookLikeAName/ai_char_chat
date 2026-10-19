// 相關的角色：例如同一間公司的同事。AI 補完、一致性檢查會參考他們，聊天時 avatar 也知道自己認識他們。
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { MAX_AVATAR_LINKS, type AvatarLink } from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { AvatarImage } from './AvatarImage.tsx';
import { Icon } from './Icon.tsx';

export function RelatedAvatarsCard({
  selfId,
  selfName,
  value,
  onChange,
}: {
  selfId: string | null;
  selfName: string;
  value: AvatarLink[];
  onChange: (v: AvatarLink[]) => void;
}) {
  const { data: all = [] } = useQuery({ queryKey: qk.avatars, queryFn: api.avatars });
  const [pick, setPick] = useState('');
  const others = all.filter((a) => a.id !== selfId);
  const choices = others.filter((a) => !value.some((l) => l.avatarId === a.id));
  const me = selfName.trim() || '這個角色';

  const setRelation = (id: string, relation: string) =>
    onChange(value.map((l) => (l.avatarId === id ? { ...l, relation } : l)));

  if (!others.length && !value.length) return null;

  return (
    <section className="card">
      <h2>相關的角色</h2>
      <p className="hint">
        選擇和{me}有關係的 avatar，例如同一間公司的同事、室友、家人。AI 補完與一致性檢查會參考他們的設定，讓公司、地點、認識的經過對得上；聊天時{me}也會知道自己認識他們。
      </p>
      {value.length > 0 && (
        <ul className="related-list">
          {value.map((l) => {
            const a = all.find((x) => x.id === l.avatarId);
            return (
              <li key={l.avatarId}>
                <AvatarImage name={a?.name ?? '?'} src={a?.imageUrl ?? null} size={36} />
                <div className="related-body">
                  {a ? (
                    <Link className="member-name" to={`/avatars/${a.id}`}>
                      {a.name}
                    </Link>
                  ) : (
                    <span className="member-name">（已刪除）</span>
                  )}
                  <input
                    value={l.relation}
                    maxLength={200}
                    aria-label={`和${a?.name ?? '這個角色'}的關係`}
                    placeholder={`例如：同一間設計公司的同事，${a?.name ?? '對方'}是${me}的主管`}
                    onChange={(e) => setRelation(l.avatarId, e.target.value)}
                  />
                  {!l.relation.trim() && <span className="hint warn-text">請寫一句你們的關係</span>}
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`移除${a?.name ?? ''}`}
                  onClick={() => onChange(value.filter((x) => x.avatarId !== l.avatarId))}
                >
                  <Icon name="close" size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {choices.length > 0 && value.length < MAX_AVATAR_LINKS && (
        <div className="related-add">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="選擇相關的角色">
            <option value="">選擇 avatar…</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.bio ? `｜${a.bio.slice(0, 30)}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={!pick}
            onClick={() => {
              onChange([...value, { avatarId: pick, relation: '' }]);
              setPick('');
            }}
          >
            加入
          </button>
        </div>
      )}
      {value.length > 0 && <p className="hint">關係的描述兩邊共用（在對方的頁面也看得到），請用名字寫清楚誰是誰。</p>}
    </section>
  );
}
