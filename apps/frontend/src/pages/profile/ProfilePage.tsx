import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { INSTRUMENTS, INSTRUMENT_IDS, progress, type InstrumentId, type ProfileDto } from '@acc/shared';
import { Icon } from '../../components/Icon.tsx';
import { PreferencesForm } from '../../components/profile/PreferencesForm.tsx';
import { Questionnaire } from '../../components/profile/Questionnaire.tsx';
import { AttachmentChart, BigFiveChart, ValuesChart } from '../../components/profile/Results.tsx';
import { SummaryCard } from '../../components/profile/SummaryCard.tsx';
import { useAnswers } from '../../components/profile/useAnswers.ts';
import { api, qk } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function ProfilePage() {
  const { data: profile } = useQuery({ queryKey: qk.profile, queryFn: api.profile });
  const [taking, setTaking] = useState<InstrumentId | null>(null);
  const [editingPrefs, setEditingPrefs] = useState(false);

  if (!profile) return <main className="pane-main full"><p className="hint pad">載入中…</p></main>;
  if (!profile.preferences) {
    return (
      <main className="pane-main full">
        <div className="chat-empty">
          <Icon name="profile" size={40} />
          <p>還沒建立你的 profile</p>
          <Link className="btn btn-primary" to="/welcome">
            開始
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="pane-main">
      <div className="editor">
        <header className="editor-head">
          <h1>我的 profile</h1>
        </header>
        {taking ? (
          <TakeTest instrument={taking} profile={profile} onDone={() => setTaking(null)} />
        ) : (
          <>
            <SummaryCard profile={profile} />
            <PreferencesCard profile={profile} editing={editingPrefs} setEditing={setEditingPrefs} />
            <ResultsSection onTake={setTaking} />
          </>
        )}
      </div>
    </main>
  );
}

function PreferencesCard({
  profile,
  editing,
  setEditing,
}: {
  profile: ProfileDto;
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: api.savePreferences,
    onSuccess: (p) => {
      qc.setQueryData(qk.profile, p);
      setEditing(false);
      toast('已儲存', 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  const p = profile.preferences!;
  return (
    <section className="card">
      <div className="card-head">
        <h2>關於你</h2>
        {!editing && (
          <button className="btn btn-small" onClick={() => setEditing(true)}>
            修改
          </button>
        )}
      </div>
      {editing ? (
        <PreferencesForm initial={p} submitLabel="儲存" saving={save.isPending} onSubmit={(x) => save.mutate(x)} />
      ) : (
        <dl className="prefs-view">
          <dt>稱呼</dt>
          <dd>{p.nickname}</dd>
          {p.interests.length > 0 && (
            <>
              <dt>興趣</dt>
              <dd>{p.interests.join('、')}</dd>
            </>
          )}
          {p.avoidTopics.length > 0 && (
            <>
              <dt>不想聊</dt>
              <dd>{p.avoidTopics.join('、')}</dd>
            </>
          )}
          {p.about && (
            <>
              <dt>其他</dt>
              <dd>{p.about}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

function TakeTest({ instrument, profile, onDone }: { instrument: InstrumentId; profile: ProfileDto; onDone: () => void }) {
  const { answers, answer, sync } = useAnswers(profile.answers);
  const inst = INSTRUMENTS[instrument];
  const { answered, total } = progress(instrument, answers[instrument]);
  return (
    <>
      <section className="card">
        <Questionnaire instrument={inst} answers={answers[instrument] ?? {}} onAnswer={(i, v) => answer(instrument, i, v)} />
      </section>
      <footer className="editor-foot">
        <span className="hint">{answered < total ? '作答已自動存檔，可以先離開' : '全部答完了'}</span>
        <span className="spacer" />
        <button
          className="btn btn-primary"
          onClick={() => {
            void sync();
            onDone();
          }}
        >
          {answered < total ? '先到這裡' : '看結果'}
        </button>
      </footer>
    </>
  );
}

/** 三份量表的結果；onTake 有給時可以開始／繼續／重做 */
export function ResultsSection({ onTake }: { onTake?: (id: InstrumentId) => void }) {
  const { data: profile } = useQuery({ queryKey: qk.profile, queryFn: api.profile });
  if (!profile) return null;
  return (
    <>
      {INSTRUMENT_IDS.map((id) => {
        const inst = INSTRUMENTS[id];
        const { answered, total } = progress(id, profile.answers[id]);
        const r = profile.results;
        const chart =
          id === 'bigFive' && r.bigFive ? (
            <BigFiveChart result={r.bigFive} />
          ) : id === 'attachment' && r.attachment ? (
            <AttachmentChart result={r.attachment} />
          ) : id === 'values' && r.values ? (
            <ValuesChart result={r.values} />
          ) : null;
        return (
          <section key={id} className="card">
            <div className="card-head">
              <h2>{inst.title}</h2>
              <span className="hint">{inst.citation}</span>
              <span className="spacer" />
              {onTake && (
                <button className="btn btn-small" onClick={() => onTake(id)}>
                  {answered === 0 ? '開始' : answered < total ? `繼續（${answered}/${total}）` : '重新作答'}
                </button>
              )}
            </div>
            {chart ?? (
              <p className="hint">{answered === 0 ? '還沒做。' : `已答 ${answered} / ${total} 題，答完就會顯示結果。`}</p>
            )}
          </section>
        );
      })}
    </>
  );
}
