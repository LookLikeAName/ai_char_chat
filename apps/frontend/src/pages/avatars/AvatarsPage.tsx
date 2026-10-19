import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { AvatarImage } from '../../components/AvatarImage.tsx';
import { Icon } from '../../components/Icon.tsx';
import { api, qk } from '../../lib/api.ts';
import { AvatarEditor } from './AvatarEditor.tsx';

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
                <span className="chat-item-preview">
                  {!a.personaComplete && <span className="tag tag-warn">未建立人格</span>} {a.bio || '（沒有簡介）'}
                </span>
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
