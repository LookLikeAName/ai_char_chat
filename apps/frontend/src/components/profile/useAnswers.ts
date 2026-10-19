// 作答的本地狀態：點選時立刻更新畫面，同時存到伺服器（不等回應，避免連點時畫面跳回舊值）。
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AllAnswers, InstrumentId } from '@acc/shared';
import { api, qk } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function useAnswers(initial: AllAnswers) {
  const [answers, setAnswers] = useState<AllAnswers>(initial);
  const toast = useToast();
  const qc = useQueryClient();

  const answer = useCallback(
    (instrument: InstrumentId, itemId: string, value: number) => {
      setAnswers((a) => ({ ...a, [instrument]: { ...(a[instrument] ?? {}), [itemId]: value } }));
      api.patchAnswers(instrument, { [itemId]: value }).catch((err) => toast(`沒能儲存作答：${errorText(err)}`, 'error'));
    },
    [toast],
  );

  /** 離開量表時同步一次伺服器的計分結果 */
  const sync = useCallback(() => qc.invalidateQueries({ queryKey: qk.profile }), [qc]);

  return { answers, answer, sync };
}
