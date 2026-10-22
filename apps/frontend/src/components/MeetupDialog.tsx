// 開始見面：地點、情境（選填）、你怎麼出現（選填，沒寫就由 avatar 先開口）
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { shownName, STATUS_LABELS, type AvatarDto } from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { errorText, useToast } from '../lib/toast.tsx';

const PLACES = ['咖啡廳', '餐廳', '公園散步', '夜市', '電影院', '河堤邊', '對方家附近'];

export function MeetupDialog({ conversationId, avatar, onClose }: { conversationId: string; avatar?: AvatarDto; onClose: () => void }) {
  const [place, setPlace] = useState('');
  const [note, setNote] = useState('');
  const [opening, setOpening] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const name = avatar ? shownName(avatar) : '對方';

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const start = useMutation({
    mutationFn: () => api.startMeetup(conversationId, { place, note, opening }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.conversations });
      onClose();
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  // 照作息現在在忙或在睡：還是可以見面，只是提醒一下
  const status = avatar?.availability.status;
  const busy = status && status !== 'free';

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="meetup-dialog-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (place.trim()) start.mutate();
        }}
      >
        <h2 id="meetup-dialog-title">和{name}見面</h2>
        <p className="hint">
          假裝你們約出來見面了：畫面會變成面對面，{name}會馬上反應，也會用旁白描寫表情和動作。你也可以寫自己的動作和台詞。結束後會回到傳訊息，{name}會記得這次見面。
        </p>
        {busy && (
          <p className="hint warn-text">
            照作息，{name}現在{STATUS_LABELS[status]}
            {avatar.availability.activity ? `（${avatar.availability.activity}）` : ''}，見面時它會當作特地空出時間來的。
          </p>
        )}
        <label className="field">
          <span className="field-label">地點</span>
          <input value={place} maxLength={100} placeholder="例如：河堤邊的咖啡廳" onChange={(e) => setPlace(e.target.value)} autoFocus required />
        </label>
        <div className="chips-select">
          {PLACES.map((p) => (
            <button key={p} type="button" className={`chip-toggle${place === p ? ' on' : ''}`} onClick={() => setPlace(p)}>
              {p}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">
            情境 <span className="hint">（選填）</span>
          </span>
          <input value={note} maxLength={300} placeholder="例如：第一次約出來、幫對方慶生、下班後吃宵夜" onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">
            你怎麼出現 <span className="hint">（選填，沒寫的話由{name}先開口）</span>
          </span>
          <textarea
            rows={2}
            value={opening}
            maxLength={1000}
            placeholder="例如：提早到了，坐在靠窗的位置"
            onChange={(e) => setOpening(e.target.value)}
          />
        </label>
        <div className="row dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={!place.trim() || start.isPending}>
            {start.isPending ? '出發中…' : '見面'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
