// Avatar creator 的人格設定：逐欄編輯、鎖定、AI 補完、重新產生、一致性檢查。
import { useState } from 'react';
import {
  fieldMeta,
  isFieldFilled,
  missingFields,
  PERSONA_PATHS,
  PERSONA_SECTIONS,
  getField,
  setField,
  type PersonaDraft,
  type PersonaIssue,
  type PersonaPath,
  type SectionMeta,
} from '@acc/shared';
import { api } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';
import { FieldInput } from './FieldInput.tsx';

export interface PersonaState {
  name: string;
  bio: string;
  persona: PersonaDraft;
  locks: PersonaPath[];
}

interface Props {
  value: PersonaState;
  onChange: (next: PersonaState) => void;
}

type Busy = { label: string } | null;

export function PersonaEditor({ value, onChange }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState<Busy>(null);
  const [seed, setSeed] = useState('');
  const [issues, setIssues] = useState<PersonaIssue[] | null>(null);
  /** 剛由 AI 填入的欄位，短暫標示出來 */
  const [fresh, setFresh] = useState<Set<PersonaPath>>(new Set());
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(PERSONA_SECTIONS.map((s) => s.key)));

  const { persona, locks } = value;
  const missing = missingFields(persona);
  const filledCount = PERSONA_PATHS.length - missing.length;
  const lockSet = new Set(locks);

  const setFieldValue = (path: PersonaPath, v: unknown) => {
    // 玩家親手改的欄位自動鎖定，之後的 AI 補完不會動它
    onChange({ ...value, persona: setField(persona, path, v), locks: lockSet.has(path) ? locks : [...locks, path] });
  };

  const toggleLock = (path: PersonaPath) =>
    onChange({ ...value, locks: lockSet.has(path) ? locks.filter((p) => p !== path) : [...locks, path] });

  async function generate(label: string, opts: { only?: PersonaPath[]; seed?: string } = {}) {
    setBusy({ label });
    try {
      const res = await api.generatePersona({
        name: value.name,
        bio: value.bio,
        persona,
        locks,
        seed: opts.seed || undefined,
        only: opts.only,
      });
      onChange({ ...value, name: res.name || value.name, bio: res.bio || value.bio, persona: res.persona });
      setFresh(new Set(res.filled));
      setTimeout(() => setFresh(new Set()), 4000);
      if (res.failed.length) {
        toast(`有 ${res.failed.length} 個欄位沒能產生（${res.failed.map((p) => fieldMeta(p)?.label).join('、')}），可以再試一次`, 'error');
      } else {
        toast(`已填入 ${res.filled.length} 個欄位`, 'success');
      }
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setBusy({ label: '檢查一致性中…' });
    try {
      const res = await api.checkPersona({ name: value.name, bio: value.bio, persona, locks });
      setIssues(res.issues);
      if (!res.issues.length) toast('沒有發現矛盾', 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  const applySuggestion = (issue: PersonaIssue) => {
    let next = persona;
    for (const [p, v] of Object.entries(issue.suggestion)) next = setField(next, p, v);
    onChange({ ...value, persona: next });
    setFresh(new Set(Object.keys(issue.suggestion)));
    setTimeout(() => setFresh(new Set()), 4000);
    setIssues((list) => list?.filter((i) => i !== issue) ?? null);
  };

  const toggleSection = (key: string) =>
    setOpenSections((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div className="persona">
      <section className="card persona-toolbar">
        <div className="persona-progress">
          <div className="progress-bar" role="progressbar" aria-valuenow={filledCount} aria-valuemax={PERSONA_PATHS.length}>
            <span style={{ width: `${(filledCount / PERSONA_PATHS.length) * 100}%` }} />
          </div>
          <span className="hint">
            已填 {filledCount} / {PERSONA_PATHS.length} 個欄位{locks.length ? ` · 鎖定 ${locks.length} 個` : ''}
          </span>
        </div>

        <div className="row">
          <input
            className="grow"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="從一句話開始，例如：27 歲、有點毒舌但很照顧人的咖啡店店長"
            aria-label="一句話描述"
          />
          {missing.length > 0 ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!busy}
              onClick={() => generate('產生角色中…（約需 30–60 秒）', { seed })}
            >
              {missing.length === PERSONA_PATHS.length ? '產生角色' : `AI 補完 ${missing.length} 個欄位`}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!!busy || locks.length === PERSONA_PATHS.length}
              onClick={() => {
                if (confirm('要依照目前的描述，重新產生所有沒鎖定的欄位嗎？')) {
                  void generate('重新產生中…（約需 30–60 秒）', {
                    seed,
                    only: PERSONA_PATHS.filter((p) => !lockSet.has(p)),
                  });
                }
              }}
            >
              重新產生未鎖定的欄位
            </button>
          )}
        </div>
        <div className="row">
          <button type="button" className="btn" disabled={!!busy || filledCount < 10} onClick={check}>
            一致性檢查
          </button>
          <span className="hint">
            你親手填寫的欄位會自動鎖定 🔒，AI 不會改動。所有欄位都要填滿才能儲存。
          </span>
        </div>
        {busy && (
          <div className="busy" role="status">
            <span className="spinner" aria-hidden /> {busy.label}
          </div>
        )}
      </section>

      {issues && issues.length > 0 && (
        <section className="card issues">
          <h2>一致性檢查：{issues.length} 個問題</h2>
          {issues.map((issue, i) => (
            <div key={i} className="issue">
              <p className="issue-problem">{issue.problem}</p>
              <p className="hint">相關欄位：{issue.fields.map((p) => fieldMeta(p)?.label ?? p).join('、') || '—'}</p>
              {Object.keys(issue.suggestion).length > 0 ? (
                <ul className="issue-suggestions">
                  {Object.entries(issue.suggestion).map(([p, v]) => (
                    <li key={p}>
                      <b>{fieldMeta(p)?.label}</b> → {preview(v)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">相關欄位都鎖定了，需要你自己決定要不要修改。</p>
              )}
              <div className="row">
                {Object.keys(issue.suggestion).length > 0 && (
                  <button type="button" className="btn btn-small btn-primary" onClick={() => applySuggestion(issue)}>
                    套用建議
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => setIssues((list) => list?.filter((x) => x !== issue) ?? null)}
                >
                  忽略
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {PERSONA_SECTIONS.map((section) => (
        <Section
          key={section.key}
          section={section}
          persona={persona}
          lockSet={lockSet}
          fresh={fresh}
          open={openSections.has(section.key)}
          busy={!!busy}
          onToggle={() => toggleSection(section.key)}
          onField={setFieldValue}
          onLock={toggleLock}
          onRegenerate={(paths, label) => generate(label, { only: paths })}
        />
      ))}
    </div>
  );
}

function preview(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('、');
  return JSON.stringify(v);
}

function Section({
  section,
  persona,
  lockSet,
  fresh,
  open,
  busy,
  onToggle,
  onField,
  onLock,
  onRegenerate,
}: {
  section: SectionMeta;
  persona: PersonaDraft;
  lockSet: Set<string>;
  fresh: Set<string>;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onField: (path: PersonaPath, v: unknown) => void;
  onLock: (path: PersonaPath) => void;
  onRegenerate: (paths: PersonaPath[], label: string) => void;
}) {
  const paths = Object.keys(section.fields).map((f) => `${section.key}.${f}`);
  const filled = paths.filter((p) => isFieldFilled(persona, p)).length;
  const unlocked = paths.filter((p) => !lockSet.has(p));

  return (
    <section className={`card persona-section${open ? '' : ' collapsed'}`}>
      <header className="persona-section-head">
        <button type="button" className="section-toggle" onClick={onToggle} aria-expanded={open}>
          <span className="chevron" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          <h2>{section.label}</h2>
          <span className={`tag${filled < paths.length ? ' tag-warn' : ''}`}>
            {filled}/{paths.length}
          </span>
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          disabled={busy || !unlocked.length}
          onClick={() => onRegenerate(unlocked, `重新產生「${section.label}」中…`)}
          title="重新產生這一區沒鎖定的欄位"
        >
          ↻ 重新產生這區
        </button>
      </header>
      {open && (
        // AI 產生中鎖住輸入，避免結果回來時蓋掉剛改的內容
        <fieldset className="persona-fields" disabled={busy}>
          {paths.map((path) => {
            const meta = fieldMeta(path)!;
            const id = `f-${path}`;
            const locked = lockSet.has(path);
            const ok = isFieldFilled(persona, path);
            const v = getField(persona, path);
            const invalid = !ok && v !== undefined && v !== '';
            return (
              <div
                key={path}
                className={`persona-field${fresh.has(path) ? ' fresh' : ''}${!ok ? ' missing' : ''}`}
                data-path={path}
              >
                <div className="persona-field-head">
                  <label htmlFor={id} className="field-label">
                    {meta.label}
                  </label>
                  {meta.hint && <span className="hint">{meta.hint}</span>}
                  <span className="spacer" />
                  {invalid && <span className="warn-text hint">格式不完整</span>}
                  <button
                    type="button"
                    className={`icon-btn lock-btn${locked ? ' locked' : ''}`}
                    onClick={() => onLock(path)}
                    aria-pressed={locked}
                    aria-label={locked ? `解除鎖定 ${meta.label}` : `鎖定 ${meta.label}`}
                    title={locked ? '已鎖定：AI 不會改動' : '鎖定'}
                  >
                    {locked ? '🔒' : '🔓'}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={busy || locked}
                    onClick={() => onRegenerate([path], `重新產生「${meta.label}」中…`)}
                    aria-label={`重新產生 ${meta.label}`}
                    title={locked ? '鎖定中，不能重新產生' : '重新產生'}
                  >
                    ↻
                  </button>
                </div>
                <FieldInput id={id} meta={meta} value={v} onChange={(nv) => onField(path, nv)} />
              </div>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}
