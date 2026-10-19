// 相關的角色：例如同一間公司的同事。AI 補完、一致性檢查會參考他們，聊天時 avatar 也知道自己認識他們。
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { INITIAL_STAGES, MAX_AVATAR_LINKS, STAGE_LABELS, type AvatarLink, type InitialStage } from '@acc/shared';
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

  const update = (id: string, p: Partial<AvatarLink>) => onChange(value.map((l) => (l.avatarId === id ? { ...l, ...p } : l)));

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
                  <div className="related-head">
                    {a ? (
                      <Link className="member-name" to={`/avatars/${a.id}`}>
                        {a.name}
                      </Link>
                    ) : (
                      <span className="member-name">（已刪除）</span>
                    )}
                    <select
                      value={l.stage}
                      onChange={(e) => update(l.avatarId, { stage: e.target.value as InitialStage })}
                      aria-label={`和${a?.name ?? '這個角色'}一開始的關係`}
                    >
                      {INITIAL_STAGES.map((st) => (
                        <option key={st} value={st}>
                          {STAGE_LABELS[st]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    value={l.relation}
                    maxLength={200}
                    aria-label={`和${a?.name ?? '這個角色'}的關係`}
                    placeholder={`例如：同一間設計公司的同事，${a?.name ?? '對方'}是${me}的主管`}
                    onChange={(e) => update(l.avatarId, { relation: e.target.value })}
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
              onChange([...value, { avatarId: pick, relation: '', stage: 'friend' }]);
              setPick('');
            }}
          >
            加入
          </button>
        </div>
      )}
      {value.length > 0 && (
        <p className="hint">
          關係的描述兩邊共用（在對方的頁面也看得到），請用名字寫清楚誰是誰。右邊選的是他們一開始的熟悉程度，之後會隨群組裡的互動變化；改了它會把他們兩個之間的好感重新設定。
        </p>
      )}
    </section>
  );
}
