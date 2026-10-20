// 第一次使用：歡迎 → 偏好問卷 → 三份量表（可以跳過）→ 結果與摘要
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { INSTRUMENTS, progress, utilityBinding, type InstrumentId, type ProfileDto } from '@acc/shared';
import { PreferencesForm } from '../../components/profile/PreferencesForm.tsx';
import { Questionnaire } from '../../components/profile/Questionnaire.tsx';
import { useAnswers } from '../../components/profile/useAnswers.ts';
import { api, qk } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';
import { ResultsSection } from './ProfilePage.tsx';

type Step = 'intro' | 'prefs' | InstrumentId | 'done';
const STEPS: Step[] = ['intro', 'prefs', 'bigFive', 'attachment', 'values', 'done'];
const STEP_LABELS: Record<Step, string> = {
  intro: '歡迎',
  prefs: '關於你',
  bigFive: '五大人格',
  attachment: '依附風格',
  values: '價值觀',
  done: '完成',
};

export function OnboardingPage() {
  const { data: profile } = useQuery({ queryKey: qk.profile, queryFn: api.profile });
  if (!profile) return <main className="pane-main full"><p className="hint pad">載入中…</p></main>;
  return <Onboarding profile={profile} />;
}

function Onboarding({ profile }: { profile: ProfileDto }) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(profile.preferences ? 'bigFive' : 'intro');
  const { answers, answer, sync } = useAnswers(profile.answers);
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const canSummarize = !!settings && !!utilityBinding(settings, 'summary');
  const { data: allProfiles = [] } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const llmProfiles = allProfiles.filter((p) => p.kind === 'chat');
  const idx = STEPS.indexOf(step);

  const go = (s: Step) => {
    void sync();
    setStep(s);
    document.querySelector('.onboarding')?.scrollTo({ top: 0 });
  };
  const next = () => go(STEPS[idx + 1]!);

  const savePrefs = useMutation({
    mutationFn: api.savePreferences,
    onSuccess: (p) => {
      qc.setQueryData(qk.profile, p);
      next();
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  // 做完時，有系統工具模型就自動寫摘要
  const summary = useMutation({
    mutationFn: api.generateSummary,
    onSuccess: (p) => qc.setQueryData(qk.profile, p),
    onError: (err) => toast(`摘要沒能產生：${errorText(err)}`, 'error'),
  });
  useEffect(() => {
    if (step === 'done' && canSummarize && !profile.summary && !summary.isPending && !summary.isSuccess) {
      summary.mutate();
    }
  }, [step, canSummarize, profile.summary, summary]);

  const instrument = step === 'bigFive' || step === 'attachment' || step === 'values' ? INSTRUMENTS[step] : null;
  const complete = instrument ? progress(instrument.id, answers[instrument.id]).answered === instrument.items.length : false;

  return (
    <main className="pane-main full onboarding">
      <div className="editor">
        <ol className="steps" aria-label="步驟">
          {STEPS.map((s, i) => (
            <li key={s} className={i === idx ? 'current' : i < idx ? 'past' : ''} aria-current={i === idx ? 'step' : undefined}>
              {STEP_LABELS[s]}
            </li>
          ))}
        </ol>

        {step === 'intro' && (
          <section className="card intro">
            <h1>歡迎！先讓 avatar 認識你一下</h1>
            <p>
              接下來有一份簡短的「關於你」問卷，和三份心理學研究常用的量表：五大人格、依附風格、價值觀，大約 10 分鐘。
              結果會整理成一段摘要，讓 avatar 知道怎麼和你相處：例如你喜歡怎麼聊天、在意什麼、在親近關係裡需要什麼。
            </p>
            <ul className="hint">
              <li>只有「怎麼稱呼你」是必填；量表可以跳過，之後再到「我的 profile」補做。</li>
              <li>作答會隨時存檔，可以中途離開。</li>
              <li>資料存在你自己的伺服器；產生摘要與聊天時，相關內容會送到你設定的 LLM 供應商。</li>
              <li>中文題目為本專案翻譯，結果僅供參考，不是心理診斷。</li>
            </ul>
            <div className="row">
              <span className="spacer" />
              <button className="btn btn-primary" onClick={next}>
                開始
              </button>
            </div>
          </section>
        )}

        {step === 'prefs' && (
          <section className="card">
            <h2>關於你</h2>
            <PreferencesForm
              initial={profile.preferences}
              submitLabel="下一步"
              saving={savePrefs.isPending}
              onSubmit={(p) => savePrefs.mutate(p)}
            />
          </section>
        )}

        {instrument && (
          <>
            <section className="card">
              <Questionnaire
                instrument={instrument}
                answers={answers[instrument.id] ?? {}}
                onAnswer={(item, v) => answer(instrument.id, item, v)}
              />
            </section>
            <footer className="editor-foot">
              <button className="btn btn-ghost" onClick={() => go(STEPS[idx - 1]!)}>
                上一步
              </button>
              <span className="spacer" />
              {!complete && (
                <button className="btn btn-ghost" onClick={next}>
                  先跳過
                </button>
              )}
              <button className="btn btn-primary" onClick={next} disabled={!complete}>
                下一步
              </button>
            </footer>
          </>
        )}

        {step === 'done' && (
          <>
            <section className="card intro">
              <h1>完成了，{profile.preferences?.nickname ?? ''}！</h1>
              {summary.isPending && (
                <div className="busy" role="status">
                  <span className="spinner" aria-hidden /> 正在整理給 avatar 的摘要…
                </div>
              )}
              <p className="hint">
                之後可以在左側的「我的 profile」查看結果、補做或重做量表、修改摘要。
              </p>
              <div className="row">
                {llmProfiles.length === 0 ? (
                  <>
                    <span className="hint">下一步：設定 avatar 要用的 LLM。</span>
                    <span className="spacer" />
                    <Link className="btn btn-primary" to="/settings/llm">
                      設定 LLM
                    </Link>
                  </>
                ) : (
                  <>
                    <span className="spacer" />
                    <button className="btn btn-primary" onClick={() => navigate('/chats')}>
                      開始聊天
                    </button>
                  </>
                )}
              </div>
            </section>
            <ResultsSection />
          </>
        )}
      </div>
    </main>
  );
}
