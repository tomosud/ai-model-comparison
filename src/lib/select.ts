import { findMetric, metricKeyOf, parseMetricKey, scenarioCostUsd } from './calc';
import type { Catalog, MetricKey, Model } from './types';

export const MAJOR_PROVIDERS = ['openai', 'anthropic', 'google'];
export const EXTRA_PROVIDERS = ['deepseek', 'meta-llama', 'mistralai', 'x-ai', 'qwen'];

export interface FilterState {
  providers: string[];
  scope: 'main' | 'all';
  ageMonths: number; // 0 = 制限なし
  query: string;
  maxCount: number;
}

function ageOk(m: Model, months: number, now: number): boolean {
  if (!months) return true;
  if (!m.createdAt) return false;
  return now - Date.parse(m.createdAt) <= months * 30.5 * 86400_000;
}

/** フィルタを適用した表示対象。主要表示では隠す種類を除き、新しい順に maxCount 件 */
export function filterModels(cat: Catalog, f: FilterState, now = Date.now()): Model[] {
  const q = f.query.trim().toLowerCase();
  const list = cat.models.filter((m) => {
    if (f.providers.length && !f.providers.includes(m.providerSlug)) return false;
    if (f.scope === 'main' && m.hiddenReasons.length) return false;
    if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) return false;
    return ageOk(m, f.ageMonths, now);
  });
  list.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return f.maxCount > 0 ? list.slice(0, f.maxCount) : list;
}

/** 表示中モデルに実在する指標と、その評価件数 */
export function availableMetrics(models: Model[]): { key: MetricKey; count: number }[] {
  const counts = new Map<MetricKey, number>();
  for (const m of models) for (const r of m.metrics) counts.set(metricKeyOf(r), (counts.get(metricKeyOf(r)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => {
      const ai = parseMetricKey(a.key).metric === 'intelligence_index' ? 0 : 1;
      const bi = parseMetricKey(b.key).metric === 'intelligence_index' ? 0 : 1;
      return ai - bi || b.count - a.count || a.key.localeCompare(b.key);
    });
}

/** 初期指標: intelligence_index を優先し、無ければ件数の多いもの */
export function defaultMetric(models: Model[]): MetricKey | null {
  return availableMetrics(models)[0]?.key ?? null;
}

/**
 * 初期基準: 主要 3 社の中で、指標スコアと有料の価格があるもののうち最も新しいもの。
 * スコアのある候補が無ければ、価格があるもののうち最新（価格比だけは出せる）。
 */
export function defaultBase(models: Model[], metric: MetricKey | null): Model | null {
  const major = models
    .filter((m) => MAJOR_PROVIDERS.includes(m.providerSlug) && m.hiddenReasons.length === 0)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const priced = major.filter((m) => (scenarioCostUsd(m, 1, 1) ?? 0) > 0);
  return priced.find((m) => findMetric(m, metric) !== null) ?? priced[0] ?? null;
}
