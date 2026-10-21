// 關係階段的選項：「炮友」只有開啟成人內容時才出現
import { useQuery } from '@tanstack/react-query';
import { INITIAL_STAGES, STAGES, type InitialStage, type Stage } from '@acc/shared';
import { api, qk } from './api.ts';

export function useStageOptions(current?: Stage) {
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const adult = !!settings?.adultContent;
  // 已經是炮友的（例如之後關掉了成人內容）還是要顯示目前的值
  const keep = (s: Stage) => adult || s !== 'fwb' || s === current;
  return {
    adult,
    initial: INITIAL_STAGES.filter(keep) as InitialStage[],
    all: STAGES.filter(keep),
  };
}
