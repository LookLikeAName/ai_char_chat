// 成人內容測試：選一個聊天用的設定檔，看它會照做、只到暗示、拒絕，還是被供應商擋下
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ADULT_TEST_LABELS, type AdultTestResult } from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { errorText } from '../lib/toast.tsx';

const JUDGED_BY: Record<AdultTestResult['judgedBy'], string> = {
  utility: '由系統工具模型判斷',
  keywords: '沒有設定系統工具模型（或它不肯判斷），用關鍵字粗略判斷',
  provider: '依供應商的回應判斷',
};

export function AdultTestPanel() {
  const { data: all = [] } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const profiles = all.filter((p) => p.kind === 'chat').sort((a, b) => b.usedBy - a.usedBy);
  const [picked, setPicked] = useState('');
  const profileId = picked || profiles[0]?.id || '';
  const test = useMutation({ mutationFn: () => api.adultTest(profileId) });
  const r = test.data;

  if (!profiles.length) return <p className="hint">建立聊天用的 LLM 設定檔之後，可以在這裡測試它能不能寫成人內容。</p>;

  return (
    <div className="adult-test">
      <span className="field-label">測試模型</span>
      <div className="related-add">
        <select
          value={profileId}
          onChange={(e) => {
            setPicked(e.target.value);
            test.reset();
          }}
          aria-label="要測試的設定檔"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.model}）{p.usedBy ? `・${p.usedBy} 個 avatar 使用` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? '測試中…' : '測試'}
        </button>
      </div>
      <span className="hint">
        用一個交往中的測試角色，請模型把親密的過程露骨地寫出來，看它的反應。會呼叫一次這個模型（有系統工具模型時再加一次判斷），計入用量。
      </span>
      {test.isError && <p className="warn-text">{errorText(test.error)}</p>}
      {r && (
        <div className={`adult-result verdict-${r.verdict}`} role="status">
          <strong>{ADULT_TEST_LABELS[r.verdict].title}</strong>
          <span>{ADULT_TEST_LABELS[r.verdict].text}</span>
          {r.reason && <span className="hint">{r.reason}</span>}
          <span className="hint">
            {JUDGED_BY[r.judgedBy]}
            {r.finishReason ? `・結束原因：${r.finishReason}` : ''}
          </span>
          {(r.verdict === 'partial' || r.verdict === 'refused' || r.verdict === 'blocked') && (
            <span className="hint">
              想要更開放的內容，可以替個別 avatar 改綁限制較少的模型（例如自己架的 Ollama、LM Studio 等本機模型）。
            </span>
          )}
          {r.reply.length > 0 && (
            <details>
              <summary>看模型的回覆</summary>
              {r.reply.map((m, i) => (
                <p key={i} className="adult-reply">
                  {m}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
