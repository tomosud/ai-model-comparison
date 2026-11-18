import type { MetricKey, MetricRecord, Model, Row } from './types';

/** 想定コスト（USD）。どちらかの単価が不明なら null。0 は無料として 0 を返す */
export function scenarioCostUsd(m: Pick<Model, 'inputUsdPerMillion' | 'outputUsdPerMillion'>, inputTokens: number, outputTokens: number): number | null {
  const i = m.inputUsdPerMillion;
  const o = m.outputUsdPerMillion;
  if (i === null || o === null || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return null;
  return (i * inputTokens) / 1_000_000 + (o * outputTokens) / 1_000_000;
}

/** a / b。どちらかが null・b が 0・結果が非有限なら null（Infinity / NaN を出さない） */
export function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

/** 費用 0（無料）や不明のときは効率を定義しない */
export function scorePerDollar(score: number | null, cost: number | null): number | null {
  if (score === null || cost === null || cost <= 0) return null;
  return ratio(score, cost);
}

export function metricKeyOf(r: Pick<MetricRecord, 'source' | 'metric' | 'version'>): MetricKey {
  return `${r.source}|${r.metric}|${r.version ?? ''}`;
}

export function parseMetricKey(k: MetricKey): { source: string; metric: string; version: string | null } {
  const [source = '', metric = '', version = ''] = k.split('|');
  return { source, metric, version: version || null };
}

export function findMetric(m: Model, key: MetricKey | null): MetricRecord | null {
  if (!key) return null;
  return m.metrics.find((r) => metricKeyOf(r) === key) ?? null;
}

/**
 * パレート優越: A が B 以上の性能かつ B 以下のコストで、少なくとも一方で厳密に優れる。
 * 戻り値は非優越（フロンティア）の index 集合。
 */
export function paretoFrontier(points: { cost: number; score: number }[]): Set<number> {
  const res = new Set<number>();
  points.forEach((p, i) => {
    const dominated = points.some((q, j) => j !== i && q.score >= p.score && q.cost <= p.cost && (q.score > p.score || q.cost < p.cost));
    if (!dominated) res.add(i);
  });
  return res;
}

/** Elo のような「差で見る」尺度は比をとっても意味が無いので、比と効率を出さない */
export function isRatioMetric(metricKey: MetricKey | null): boolean {
  return !metricKey || !parseMetricKey(metricKey).metric.endsWith('_elo');
}

export function buildRows(models: Model[], base: Model | null, metricKey: MetricKey | null, inputTokens: number, outputTokens: number): Row[] {
  const ratioOk = isRatioMetric(metricKey);
  const baseCost = base ? scenarioCostUsd(base, inputTokens, outputTokens) : null;
  const baseMetric = base ? findMetric(base, metricKey) : null;
  const baseScore = ratioOk ? baseMetric?.score ?? null : null;
  const baseSpd = baseScore !== null ? scorePerDollar(baseScore, baseCost) : null;

  const rows: Row[] = models.map((m) => {
    const cost = scenarioCostUsd(m, inputTokens, outputTokens);
    const metric = findMetric(m, metricKey);
    const score = metric?.score ?? null;
    const spd = ratioOk ? scorePerDollar(score, cost) : null;
    return {
      model: m,
      cost,
      score,
      metric,
      relScore: ratio(score, baseScore),
      relCost: ratio(cost, baseCost),
      relEfficiency: ratio(spd, baseSpd),
      relSpeed: base ? ratio(m.throughputTps, base.throughputTps) : null,
      relLatency: base ? ratio(m.latencySeconds, base.latencySeconds) : null,
      scorePerDollar: spd,
      pareto: false,
    };
  });

  const plotted = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.score !== null && r.cost !== null);
  const front = paretoFrontier(plotted.map(({ r }) => ({ cost: r.cost as number, score: r.score as number })));
  plotted.forEach(({ r }, k) => {
    if (front.has(k)) r.pareto = true;
  });
  return rows;
}

export function fmtRatio(v: number | null): string {
  return v === null ? 'N/A' : `${v.toFixed(2)}×`;
}

export function fmtUsd(v: number | null): string {
  if (v === null) return 'N/A';
  if (v === 0) return '$0（無料）';
  if (v < 0.01) return `$${v.toPrecision(2)}`;
  return `$${v.toFixed(v < 10 ? 3 : 2)}`;
}

export function fmtNum(v: number | null, digits = 1): string {
  return v === null ? 'N/A' : v.toFixed(digits);
}
