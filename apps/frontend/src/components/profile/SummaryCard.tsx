import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ProfileDto } from '@acc/shared';
import { api, qk } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

/** 系統工具模型寫的「關於你」摘要；avatar 會把它當作和你相處的參考 */
export function SummaryCard({ profile }: { profile: ProfileDto }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const [editing, setEditing] = useState<string | null>(null);

  const done = (p: ProfileDto) => qc.setQueryData(qk.profile, p);
  const generate = useMutation({
    mutationFn: api.generateSummary,
    onSuccess: (p) => {
      done(p);
      toast('摘要已更新', 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  const save = useMutation({
    mutationFn: (s: string) => api.setSummary(s),
    onSuccess: (p) => {
      done(p);
      setEditing(null);
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <section className="card">
      <h2>給 avatar 的參考摘要</h2>
      <p className="hint">
        avatar 會把這段當作「相處下來對你的感覺」，不會提到測驗或分數。摘要由系統工具模型依你的回答撰寫，你可以直接修改。
      </p>
      {editing !== null ? (
        <>
          <textarea rows={8} value={editing} onChange={(e) => setEditing(e.target.value)} maxLength={3000} />
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => save.mutate(editing)} disabled={save.isPending}>
              儲存
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </>
      ) : (
        <>
          {profile.summary ? <p className="summary-text">{profile.summary}</p> : <p className="hint">還沒有摘要。</p>}
          {profile.summaryStale && <p className="warn-text hint">你的回答在摘要產生之後有更新，建議重新產生。</p>}
          <div className="row">
            {settings?.utilityLlm ? (
              <button type="button" className="btn" onClick={() => generate.mutate()} disabled={generate.isPending}>
                {generate.isPending ? '撰寫中…' : profile.summary ? '重新產生' : '產生摘要'}
              </button>
            ) : (
              <span className="hint">
                要自動產生摘要，請先到 <Link to="/settings/general">設定 → 一般</Link> 選擇系統工具模型。
              </span>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(profile.summary)}>
              {profile.summary ? '修改' : '自己寫'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
