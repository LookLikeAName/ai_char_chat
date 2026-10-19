// 測驗結果的圖表：五大人格（單一系列長條）、依附（焦慮 × 逃避的位置圖）、價值觀（以個人平均為中線的發散長條）。
import {
  ATTACHMENT_LABELS,
  BIG_FIVE,
  BIG_FIVE_LABELS,
  SCHWARTZ_LABELS,
  type AttachmentResult,
  type BigFiveResult,
  type BigFiveTrait,
  type ValuesResult,
} from '@acc/shared';

const TRAIT_POLES: Record<BigFiveTrait, [string, string]> = {
  openness: ['務實、偏好熟悉的事物', '好奇、想像力豐富'],
  conscientiousness: ['隨性、彈性', '有條理、自律'],
  extraversion: ['安靜、需要獨處充電', '外向、從人群得到能量'],
  agreeableness: ['直接、重視自己的立場', '體貼、重視和諧'],
  neuroticism: ['情緒穩定、不易緊張', '敏感、情緒起伏較大'],
};

export function level(score: number): string {
  if (score >= 80) return '很高';
  if (score >= 60) return '偏高';
  if (score > 40) return '中等';
  if (score > 20) return '偏低';
  return '很低';
}

export function BigFiveChart({ result }: { result: BigFiveResult }) {
  return (
    <div className="bf-chart">
      {BIG_FIVE.map((t) => {
        const s = result.scores[t];
        return (
          <div key={t} className="bf-row" title={`${BIG_FIVE_LABELS[t]}：${s}（平均 ${result.means[t]} / 5）`}>
            <div className="bf-label">
              <span>{BIG_FIVE_LABELS[t]}</span>
              <span className="bf-value">
                {s}
                <span className="hint">（{level(s)}）</span>
              </span>
            </div>
            <div className="bf-track" role="img" aria-label={`${BIG_FIVE_LABELS[t]} ${s} 分，${level(s)}`}>
              <span className="bf-fill" style={{ width: `${Math.max(s, 2)}%` }} />
            </div>
            <div className="bf-poles hint">
              <span>{TRAIT_POLES[t][0]}</span>
              <span>{TRAIT_POLES[t][1]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const ATTACHMENT_TEXT = {
  secure: '在親近關係裡大致自在：願意依賴別人，也不太擔心被拋下。',
  anxious: '很在乎對方的回應，容易擔心被冷落；需要對方常常確認心意。',
  avoidant: '重視自己的空間，不太習慣依賴別人或把心事說出口。',
  fearful: '想靠近又怕受傷：渴望親密，但也會擔心而退縮。',
} as const;

export function AttachmentChart({ result }: { result: AttachmentResult }) {
  // 1～7 映射到 0～200 的方格，焦慮越高越上方
  const size = 200;
  const pos = (v: number) => ((v - 1) / 6) * size;
  const x = pos(result.avoidance);
  const y = size - pos(result.anxiety);
  return (
    <div className="att">
      <svg
        className="att-chart"
        viewBox={`-34 -8 ${size + 42} ${size + 36}`}
        role="img"
        aria-label={`依附焦慮 ${result.anxiety}、依附逃避 ${result.avoidance}（1 到 7），大致是${ATTACHMENT_LABELS[result.style]}`}
      >
        <rect x={0} y={0} width={size} height={size} className="att-bg" rx={6} />
        <line x1={size / 2} y1={0} x2={size / 2} y2={size} className="att-mid" />
        <line x1={0} y1={size / 2} x2={size} y2={size / 2} className="att-mid" />
        {/* 象限名稱放在外側角落，避免和位置點重疊 */}
        <text x={8} y={size - 8} className="att-q">安全型</text>
        <text x={size - 8} y={size - 8} className="att-q end">逃避型</text>
        <text x={8} y={16} className="att-q">焦慮型</text>
        <text x={size - 8} y={16} className="att-q end">恐懼逃避型</text>
        <circle cx={x} cy={y} r={7} className="att-dot">
          <title>
            焦慮 {result.anxiety}、逃避 {result.avoidance}
          </title>
        </circle>
        <text x={size / 2} y={size + 22} className="att-axis">
          逃避 →
        </text>
        <text x={-12} y={size / 2} className="att-axis" transform={`rotate(-90 -12 ${size / 2})`}>
          焦慮 →
        </text>
      </svg>
      <div className="att-text">
        <p className="att-style">{ATTACHMENT_LABELS[result.style]}</p>
        <p>{ATTACHMENT_TEXT[result.style]}</p>
        <p className="hint">
          焦慮 {result.anxiety}、逃避 {result.avoidance}（1–7，4 為中點）。量表本身是連續的兩個向度，類型只是粗略的描述。
        </p>
      </div>
    </div>
  );
}

export function ValuesChart({ result }: { result: ValuesResult }) {
  // 以 ±2.5 為滿版；扣掉個人平均後大多落在這個範圍內
  const LIMIT = 2.5;
  return (
    <div className="val-chart">
      <p className="hint val-note">中線是你所有題目的平均：右邊是比平常更看重的，左邊是相對不那麼看重的。</p>
      <div className="val-legend hint" aria-hidden>
        <span>← 較不重要</span>
        <span>較重要 →</span>
      </div>
      {result.ranking.map((v, i) => {
        const c = result.centered[v];
        const w = (Math.min(Math.abs(c), LIMIT) / LIMIT) * 50;
        return (
          <div key={v} className="val-row" title={`${SCHWARTZ_LABELS[v]}：${c >= 0 ? '+' : ''}${c}（平均 ${result.means[v]} / 6）`}>
            <span className="val-label">
              <span className="val-rank">{i + 1}</span>
              {SCHWARTZ_LABELS[v].split('（')[0]}
            </span>
            <span className="val-track">
              <span className="val-axis" />
              <span
                className={`val-fill ${c >= 0 ? 'pos' : 'neg'}`}
                style={c >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
              />
            </span>
            <span className="val-num">
              {c >= 0 ? '+' : ''}
              {c.toFixed(1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
