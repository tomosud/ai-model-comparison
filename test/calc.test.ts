import { describe, expect, it } from 'vitest';
import { buildRows, fmtRatio, paretoFrontier, ratio, scenarioCostUsd, scorePerDollar } from '../src/lib/calc';
import type { Model } from '../src/lib/types';
import { attachMetrics, normalizeBenchmarkResponse, normalizeModel, perTokenToPerMillion, medianP50 } from '../scripts/normalize.mjs';

function model(id: string, inp: number | null, out: number | null, score: number | null, tps: number | null = null): Model {
  return {
    id, canonicalSlug: null, name: id, provider: 'X', providerSlug: id.split('/')[0], createdAt: null,
    inputUsdPerMillion: inp, outputUsdPerMillion: out, contextLength: null, supportedParameters: [], inputModalities: [], outputModalities: ['text'],
    hiddenReasons: [], throughputTps: tps, latencySeconds: null, speedMeasuredAt: null,
    metrics: score === null ? [] : [{ source: 's', metric: 'intelligence_index', score, evaluatedAt: null, version: null, config: null }],
  };
}
const KEY = 's|intelligence_index|';

describe('受け入れテスト（仕様 12 章）', () => {
  it('スコア 80 基準・100 比較 → 1.25×', () => {
    const b = model('a/base', 1, 1, 80);
    const m = model('a/m', 1, 1, 100);
    const r = buildRows([b, m], b, KEY, 1_000_000, 0);
    expect(r[1].relScore).toBeCloseTo(1.25);
    expect(fmtRatio(r[1].relScore)).toBe('1.25×');
  });
  it('コスト $2 基準・$1 比較 → 0.50×', () => {
    const b = model('a/base', 2, 0, 50);
    const m = model('a/m', 1, 0, 50);
    const r = buildRows([b, m], b, KEY, 1_000_000, 0);
    expect(r[0].cost).toBe(2);
    expect(r[1].relCost).toBeCloseTo(0.5);
  });
  it('速度 50 基準・100 比較 → 2.00×', () => {
    const b = model('a/base', 1, 1, 50, 50);
    const m = model('a/m', 1, 1, 50, 100);
    expect(buildRows([b, m], b, KEY, 1, 1)[1].relSpeed).toBeCloseTo(2);
  });
  it('基準モデル自身は (1, 1)', () => {
    const b = model('a/base', 3, 15, 70);
    const [r] = buildRows([b], b, KEY, 1_000_000, 250_000);
    expect(r.relCost).toBe(1);
    expect(r.relScore).toBe(1);
    expect(r.relEfficiency).toBe(1);
  });
  it('トークン数を変えると想定コストと相対コストが変わる', () => {
    const b = model('a/base', 1, 10, 50);
    const m = model('a/m', 2, 2, 50);
    const r1 = buildRows([b, m], b, KEY, 1_000_000, 0)[1];
    const r2 = buildRows([b, m], b, KEY, 0, 1_000_000)[1];
    expect(r1.cost).toBe(2);
    expect(r2.cost).toBe(2);
    expect(r1.relCost).toBeCloseTo(2);
    expect(r2.relCost).toBeCloseTo(0.2);
  });
  it('スコアの無いモデルはスコア 0 にならない', () => {
    const b = model('a/base', 1, 1, 50);
    const m = model('a/m', 1, 1, null);
    const r = buildRows([b, m], b, KEY, 1, 1)[1];
    expect(r.score).toBeNull();
    expect(r.relScore).toBeNull();
    expect(r.pareto).toBe(false);
  });
  it('無料モデルや基準値 0 で Infinity / NaN を出さない', () => {
    const free = model('a/free', 0, 0, 40);
    const paid = model('a/paid', 1, 1, 60);
    const asBase = buildRows([free, paid], free, KEY, 1000, 1000);
    expect(asBase[1].relCost).toBeNull();
    expect(asBase[0].scorePerDollar).toBeNull();
    expect(asBase[1].relEfficiency).toBeNull();
    const asOther = buildRows([free, paid], paid, KEY, 1000, 1000);
    expect(asOther[0].relCost).toBe(0);
    expect(asOther[0].relEfficiency).toBeNull();
    for (const r of [...asBase, ...asOther]) for (const v of [r.relCost, r.relScore, r.relEfficiency, r.relSpeed]) expect(v === null || Number.isFinite(v)).toBe(true);
  });
  it('基準なしでも落ちない', () => {
    const r = buildRows([model('a/m', 1, 1, 10)], null, KEY, 1, 1);
    expect(r[0].relScore).toBeNull();
  });
});

describe('計算部品', () => {
  it('価格不明は null、0 は無料', () => {
    expect(scenarioCostUsd({ inputUsdPerMillion: null, outputUsdPerMillion: 1 }, 1, 1)).toBeNull();
    expect(scenarioCostUsd({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, 1e6, 1e6)).toBe(0);
    expect(scenarioCostUsd({ inputUsdPerMillion: 3, outputUsdPerMillion: 15 }, 1_000_000, 250_000)).toBeCloseTo(6.75);
  });
  it('ratio / scorePerDollar', () => {
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(null, 1)).toBeNull();
    expect(scorePerDollar(50, 0)).toBeNull();
    expect(scorePerDollar(50, 2)).toBe(25);
  });
  it('パレート: 劣るものだけ外れる', () => {
    const f = paretoFrontier([
      { cost: 1, score: 50 },
      { cost: 2, score: 70 },
      { cost: 3, score: 60 }, // (2,70) に優越される
      { cost: 2, score: 70 }, // 同値は互いに優越しない
    ]);
    expect([...f].sort()).toEqual([0, 1, 3]);
  });
});

describe('正規化', () => {
  it('USD/トークンの文字列 → USD/100万', () => {
    expect(perTokenToPerMillion('0.000002')).toBe(2);
    expect(perTokenToPerMillion('0')).toBe(0);
    expect(perTokenToPerMillion(null)).toBeNull();
    expect(perTokenToPerMillion('-1')).toBeNull();
    expect(perTokenToPerMillion('abc')).toBeNull();
  });
  it('派生・画像出力は既定で隠す', () => {
    expect(normalizeModel({ id: 'openai/x:free', pricing: {} }).hiddenReasons).toContain('variant:free');
    expect(normalizeModel({ id: 'google/img', architecture: { output_modalities: ['image', 'text'] } }).hiddenReasons).toContain('non-text-output');
    expect(normalizeModel({ id: 'openai/gpt-x', architecture: { output_modalities: ['text'] } }).hiddenReasons).toEqual([]);
    expect(normalizeModel({ name: 'no id' })).toBeNull();
  });
  it('AA 項目は指標ごとに分け、permaslug で照合（表示名は使わない）', () => {
    const recs = normalizeBenchmarkResponse({
      data: [
        { source: 'artificial-analysis', model_permaslug: 'openai/m-2026', display_name: 'Other Name', intelligence_index: 70, coding_index: null },
        { source: 'openrouter', model_permaslug: 'openai/m', benchmark_type: 'gpqa_diamond', accuracy: 0.8, last_run_timestamp: '2026-01-02T00:00:00Z' },
        { source: 'artificial-analysis', model_permaslug: 'nobody/x', intelligence_index: 1 },
      ],
      meta: { as_of: '2026-01-01T00:00:00Z', version: 'v1' },
    });
    expect(recs).toHaveLength(3);
    const m = normalizeModel({ id: 'openai/m', canonical_slug: 'openai/m-2026', name: 'Other Name' });
    const res = attachMetrics([m], recs);
    expect(res.matched).toBe(2);
    expect(res.unmatched).toEqual(['nobody/x']);
    expect(m.metrics.map((x: { metric: string }) => x.metric).sort()).toEqual(['gpqa_diamond_accuracy', 'intelligence_index']);
  });
  it('速度は p50 の中央値', () => {
    expect(medianP50([{ t: { p50: 10 } }, { t: { p50: 30 } }, { t: null }], 't')).toBe(20);
    expect(medianP50([{ t: null }], 't')).toBeNull();
  });
});
