import './style.css';
import * as echarts from 'echarts/core';
import { ScatterChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
import { buildRows, fmtNum, fmtRatio, fmtUsd, parseMetricKey, scenarioCostUsd, findMetric, isRatioMetric, metricKeyOf, ratio } from './lib/calc';
import { availableMetrics, defaultBase, defaultMetric, EXTRA_PROVIDERS, filterModels, MAJOR_PROVIDERS } from './lib/select';
import type { Catalog, MetricKey, Model, Row, Usage } from './lib/types';

echarts.use([ScatterChart, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, LabelLayout, CanvasRenderer]);

// ---------- 状態 ----------
type SortKey = 'provider' | 'name' | 'score' | 'relScore' | 'cost' | 'relCost' | 'relEfficiency' | 'speed' | 'relSpeed' | 'latency' | 'relLatency' | 'usage' | 'created' | `m:${string}`;
interface State {
  data: 'live' | 'sample';
  providers: string[];
  metric: MetricKey | null;
  inTok: number;
  outTok: number;
  ageMonths: number;
  scope: 'main' | 'all';
  maxCount: number;
  order: 'new' | 'usage';
  query: string;
  mode: 'abs' | 'rel';
  logX: boolean;
  pareto: boolean;
  labels: 'all' | 'pareto' | 'none';
  speedViz: 'bar' | 'size' | 'none';
  pinBase: boolean;
  base: string | null;
  detail: string | null;
  sortKey: SortKey;
  sortDir: 1 | -1;
}

const state: State = {
  data: 'live',
  providers: [...MAJOR_PROVIDERS],
  metric: null,
  inTok: 1_000_000,
  outTok: 250_000,
  ageMonths: 12,
  scope: 'main',
  maxCount: 30,
  order: 'new',
  query: '',
  mode: 'abs',
  logX: false,
  pareto: true,
  labels: 'all',
  speedViz: 'bar',
  pinBase: true,
  base: null,
  detail: null,
  sortKey: 'relEfficiency',
  sortDir: -1,
};

let catalog: Catalog | null = null;
let visible: Model[] = [];
let rows: Row[] = [];
let chart: echarts.ECharts | null = null;

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', 'meta-llama': 'Meta', mistralai: 'Mistral', 'x-ai': 'xAI', qwen: 'Qwen',
};
const PROVIDER_VAR: Record<string, string> = {
  openai: '--c-openai', anthropic: '--c-anthropic', google: '--c-google', deepseek: '--c-deepseek', 'meta-llama': '--c-meta', mistralai: '--c-mistral', 'x-ai': '--c-xai', qwen: '--c-qwen',
};
const METRIC_LABELS: Record<string, string> = {
  intelligence_index: 'Intelligence Index',
  coding_index: 'Coding Index（旧）',
  agentic_index: 'Agentic Index（旧）',
  finance_and_accounting_index: 'Finance & Accounting Index',
  strategy_and_ops_index: 'Strategy & Ops Index',
  legal_index: 'Legal Index',
  healthcare_and_medical_index: 'Healthcare & Medical Index',
  engineering_index: 'Engineering Index',
  economics_index: 'Economics Index',
  cyber_index: 'Cyber Index',
  openness_index: 'Openness Index',
  multilingual_index: 'Multilingual Index',
  decision_index: 'Decision Index',
  gpqa_diamond_accuracy: 'GPQA Diamond 正答率 %',
  tau_bench_verified_airline_accuracy: 'τ-bench airline 正答率 %',
  design_arena_codecategories_elo: 'Design Arena コーディング Elo',
  design_arena_codecategories_win_rate: 'Design Arena コーディング勝率 %',
};
/** 縦軸の指標が何を測るか（高いほど良い） */
const METRIC_HELP: Record<string, string> = {
  intelligence_index: '総合力。Artificial Analysis が複数の評価（推論・知識・数学・コーディングなど）をまとめた指数',
  engineering_index: 'ソフトウェア・技術系の実務タスク。今のデータで「コーディング寄り」に一番近い指標',
  coding_index: 'コーディング指数。Artificial Analysis が更新をやめた旧指標で、古いモデルにしか値が無い',
  agentic_index: 'エージェント（ツールを使う多段タスク）指数。更新が止まった旧指標で、古いモデルにしか値が無い',
  gpqa_diamond_accuracy: '大学院レベルの理科の難問（GPQA Diamond）の正答率。OpenRouter が自前で計測',
  design_arena_codecategories_elo: 'Design Arena のコーディング部門。人が 2 つのモデルの成果物を見比べて投票した対戦の Elo。差で比べる尺度なので倍率（比）は出さない',
  design_arena_codecategories_win_rate: 'Design Arena のコーディング部門での勝率。対戦相手の顔ぶれで変わるので目安',
  tau_bench_verified_airline_accuracy: 'ツール呼び出しで航空会社の窓口業務をこなす課題（τ-bench）の成功率。エージェント用途の目安。OpenRouter が自前で計測',
  finance_and_accounting_index: '財務・会計の実務タスク',
  strategy_and_ops_index: '経営戦略・業務運営の実務タスク',
  legal_index: '法務の実務タスク',
  healthcare_and_medical_index: '医療・ヘルスケアの実務タスク',
  economics_index: '経済分析の実務タスク',
  cyber_index: 'サイバーセキュリティのタスク',
  multilingual_index: '多言語での性能',
  openness_index: 'モデルの公開度（重みや学習情報の開示）。性能ではない',
  decision_index: '意思決定タスク',
};

/** 0〜1 の正答率を % にそろえる（比は変わらない） */
function toPercent(c: Catalog): Catalog {
  for (const m of c.models)
    for (const r of m.metrics) if (r.metric.endsWith('_accuracy') && r.score <= 1.000001) r.score = +(r.score * 100).toFixed(3);
  return c;
}

const SOURCE_LABELS: Record<string, string> = { 'artificial-analysis': 'Artificial Analysis', openrouter: 'OpenRouter', 'design-arena': 'Design Arena', sample: 'サンプル' };

/** 表に並べて出す主な指標（用途別）。データにあるものだけ列になる */
const KEY_METRICS: { metric: string; label: string; title: string }[] = [
  { metric: 'intelligence_index', label: '総合比', title: 'Intelligence Index の基準比（総合力）' },
  { metric: 'engineering_index', label: 'エンジニア比', title: 'Engineering Index の基準比（ソフトウェア・技術系の実務。コーディング寄り）' },
  { metric: 'design_arena_codecategories_win_rate', label: 'コード勝率比', title: 'Design Arena コーディング部門の勝率の基準比（人の投票）' },
  { metric: 'tau_bench_verified_airline_accuracy', label: 'エージェント比', title: 'τ-bench airline 正答率の基準比（ツールを使う多段タスク）' },
  { metric: 'gpqa_diamond_accuracy', label: 'GPQA比', title: 'GPQA Diamond 正答率の基準比（難問の知識・推論）' },
];
let keyMetricKeys: { key: MetricKey; label: string; title: string }[] = [];

function resolveKeyMetrics() {
  keyMetricKeys = [];
  for (const km of KEY_METRICS) {
    for (const m of catalog?.models ?? []) {
      const r = m.metrics.find((x) => x.metric === km.metric);
      if (r) {
        keyMetricKeys.push({ key: metricKeyOf(r), label: km.label, title: km.title });
        break;
      }
    }
  }
}

function keyRatio(m: Model, key: MetricKey): number | null {
  const base = baseModel();
  return base ? ratio(findMetric(m, key)?.score ?? null, findMetric(base, key)?.score ?? null) : null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const providerColor = (slug: string) => cssVar(PROVIDER_VAR[slug] ?? '--c-other') || '#94a3b8';
const providerName = (slug: string) => PROVIDER_NAMES[slug] ?? slug;
const metricLabel = (key: MetricKey | null) => {
  if (!key) return '（指標なし）';
  const p = parseMetricKey(key);
  return `${METRIC_LABELS[p.metric] ?? p.metric} — ${SOURCE_LABELS[p.source] ?? p.source}${p.version ? ` ${p.version}` : ''}`;
};
const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'N/A');
const fmtDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : 'N/A');
/** トークン数を 1.2T / 340B / 12M の形に */
const fmtTok = (v: number | null | undefined) => {
  if (v === null || v === undefined) return 'N/A';
  for (const [d, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) if (v >= d) return `${(v / d).toFixed(v >= d * 100 ? 0 : 1)}${u}`;
  return String(Math.round(v));
};
/** 前の 7 日からの増減（比）。前週が 0 / 不明なら null */
const usageTrend = (u: Usage | null | undefined) => (u && u.prev7d ? u.tokens7d / u.prev7d - 1 : null);
const hasRankings = () => catalog?.sources.rankings?.status === 'ok' || catalog?.sources.rankings?.status === 'stale';
function trendHtml(t: number | null) {
  if (t === null) return '';
  const cls = Math.abs(t) < 0.005 ? 'na' : t > 0 ? 'good' : 'bad';
  return `<span class="trend ${cls}">${t > 0 ? '▲' : t < 0 ? '▼' : '＝'}${Math.abs(t * 100) >= 999 ? '999+' : Math.abs(t * 100).toFixed(0)}%</span>`;
}
/** 日ごとの利用量の小さな折れ線 */
function sparkline(vals: number[]) {
  const max = Math.max(0, ...vals);
  if (vals.length < 2 || max <= 0) return '';
  const W = 100, H = 28;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${pts.join(' ')} ${W},${H}" class="spark-area"/><polyline points="${pts.join(' ')}" class="spark-line"/></svg>`;
}
const shortName = (m: Model) => m.name.replace(/^[^:]+:\s*/, '');

// ---------- URL 状態 ----------
function readUrl() {
  const q = new URLSearchParams(location.search);
  const num = (k: string) => {
    const v = q.get(k);
    if (v === null || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  if (q.get('data') === 'sample') state.data = 'sample';
  if (q.has('p')) state.providers = (q.get('p') ?? '').split(',').filter(Boolean);
  if (q.get('m')) state.metric = q.get('m');
  state.inTok = num('in') ?? state.inTok;
  state.outTok = num('out') ?? state.outTok;
  const age = num('age');
  if (age !== null) state.ageMonths = age;
  const max = num('max');
  if (max !== null) state.maxCount = max;
  if (q.get('order') === 'usage') state.order = 'usage';
  if (q.get('scope') === 'all') state.scope = 'all';
  if (q.get('mode') === 'rel') state.mode = 'rel';
  if (q.get('log') === '1') state.logX = true;
  if (q.get('pareto') === '0') state.pareto = false;
  const lbl = q.get('lbl');
  if (lbl === 'pareto' || lbl === 'none') state.labels = lbl;
  const spd = q.get('spd');
  if (spd === 'size' || spd === 'none') state.speedViz = spd;
  state.query = q.get('q') ?? '';
  state.base = q.get('base');
}

function writeUrl() {
  const q = new URLSearchParams();
  if (state.data === 'sample') q.set('data', 'sample');
  q.set('p', state.providers.join(','));
  if (state.metric) q.set('m', state.metric);
  q.set('in', String(state.inTok));
  q.set('out', String(state.outTok));
  q.set('age', String(state.ageMonths));
  q.set('max', String(state.maxCount));
  if (state.order !== 'new') q.set('order', state.order);
  if (state.scope === 'all') q.set('scope', 'all');
  q.set('mode', state.mode);
  if (state.logX) q.set('log', '1');
  if (!state.pareto) q.set('pareto', '0');
  if (state.labels !== 'all') q.set('lbl', state.labels);
  if (state.speedViz !== 'bar') q.set('spd', state.speedViz);
  if (state.query) q.set('q', state.query);
  if (state.base) q.set('base', state.base);
  history.replaceState(null, '', `${location.pathname}?${q.toString()}${location.hash}`);
}

// ---------- データ読み込み ----------
async function load() {
  const file = state.data === 'sample' ? 'sample.catalog.json' : 'catalog.json';
  // 相対パスなので /<repo>/ 配下でも読める
  const url = new URL(`data/${file}`, document.baseURI);
  // 毎回サーバーに更新を問い合わせる（変わっていなければ 304 で軽い）。ブラウザ・CDN の古いデータを避ける
  url.searchParams.set('b', __BUILD_ID__);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = (await res.json()) as Catalog;
  if (!json || !Array.isArray(json.models)) throw new Error('データの形が想定と違います（models がありません）');
  return json;
}

function showLoadError(err: unknown) {
  const main = document.querySelector('main') as HTMLElement;
  main.innerHTML = `<div class="error-box"><strong>データを読み込めませんでした。</strong><p>${esc(String((err as Error)?.message ?? err))}</p><button class="btn" id="retry">再試行</button></div>`;
  $('retry').addEventListener('click', () => location.reload());
  $('meta').textContent = '読み込み失敗';
}

// ---------- 描画 ----------
function recompute() {
  if (!catalog) return;
  visible = filterModels(catalog, { providers: state.providers, scope: state.scope, ageMonths: state.ageMonths, query: state.query, maxCount: state.maxCount, order: state.order });
  const metrics = availableMetrics(visible);
  // 選んでいた指標が表示対象に無いときだけ差し替える（表示対象に指標が 1 つも無ければ保持）
  if (metrics.length && !metrics.some((m) => m.key === state.metric)) state.metric = defaultMetric(visible);
  // 基準はフィルタの影響を受けない（カタログ全体から引く）
  const base = baseModel();
  const T = PERF ? [performance.now()] : null;
  const lap = () => T?.push(performance.now());
  rows = buildRows(visible, base, state.metric, state.inTok, state.outTok);
  lap();
  renderMetricSelect(metrics);
  renderBanners();
  lap();
  renderChart();
  lap();
  renderBaseCard();
  renderDetail();
  renderPicks();
  lap();
  renderTable();
  lap();
  writeUrl();
  if (T) {
    const names = ['rows', 'selects', 'chart', 'cards', 'table'];
    (window as unknown as { __perf: unknown[] }).__perf ??= [];
    (window as unknown as { __perf: unknown[] }).__perf.push(Object.fromEntries(names.map((n, i) => [n, +(T[i + 1] - T[i]).toFixed(1)])));
  }
}
const PERF = new URLSearchParams(location.search).has('perf');

/** 表示中のモデルから「効率が最良・最高スコア・最安・最速」を拾って並べる（クリックで基準に） */
function renderPicks() {
  const el = $('picks');
  const best = (f: (r: Row) => number | null, dir: 1 | -1) => {
    let top: Row | null = null;
    let tv = 0;
    for (const r of rows) {
      const v = f(r);
      if (v === null || !Number.isFinite(v)) continue;
      if (!top || (v - tv) * dir > 0) { top = r; tv = v; }
    }
    return top ? { r: top, v: tv } : null;
  };
  const items: [string, string, ReturnType<typeof best>, (v: number) => string][] = [
    [ICON.eff, 'コスト効率が最良', best((r) => r.scorePerDollar, 1), (v) => `${fmtNum(v, 1)} 点/$`],
    [ICON.score, 'スコアが最高', best((r) => r.score, 1), (v) => fmtNum(v, 1)],
    [ICON.cost, '想定コストが最安（有料）', best((r) => (r.score !== null && r.cost !== null && r.cost > 0 ? r.cost : null), -1), (v) => fmtUsd(v)],
    [ICON.speed, '速度が最速', best((r) => r.model.throughputTps, 1), (v) => `${fmtNum(v, 0)} tok/s`],
    [ICON.usage, 'いちばん使われている', best((r) => (r.model.usage?.rank7d ? r.model.usage.tokens7d : null), 1), (v) => `${fmtTok(v)}/7日`],
  ];
  el.innerHTML = `<div class="f-label">表示中のいちばん</div>` + items
    .map(([ic, label, b, f]) => b
      ? `<button type="button" class="pick" data-base="${esc(b.r.model.id)}" title="クリックで基準にする"><span class="pk">${ic}${label}</span><span class="pv"><span class="dot" style="background:${providerColor(b.r.model.providerSlug)}"></span><b>${esc(shortName(b.r.model))}</b><span class="pn">${f(b.v)}</span></span></button>`
      : `<div class="pick na"><span class="pk">${ic}${label}</span><span class="pv">該当なし</span></div>`)
    .join('');
}

let modelById = new Map<string, Model>();
function baseModel(): Model | null {
  return (state.base && modelById.get(state.base)) || null;
}

function renderMeta() {
  if (!catalog) return;
  const b = catalog.sources.benchmarks;
  const bText = b.status === 'ok' ? `ベンチマーク ${fmtDate(b.fetchedAt)}` : b.status === 'stale' ? `ベンチマーク ${fmtDate(b.fetchedAt)}（前回値）` : 'ベンチマーク未取得';
  $('meta').innerHTML = `データ取得 ${esc(fmtDate(catalog.fetchedAt))} ・ ${esc(bText)} ・ 出典 <a href="https://openrouter.ai/models" target="_blank" rel="noopener">OpenRouter</a>${b.metas?.some((m) => m.source === 'artificial-analysis') ? ' / <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">Artificial Analysis</a>' : ''}`;
}

function renderBanners() {
  if (!catalog) return;
  const out: string[] = [];
  if (catalog.isSample) {
    out.push(`<div class="banner"><strong>サンプルデータを表示中です（架空の値）。</strong>実際の比較には使えません。<button class="btn" id="toLive">実データに戻る</button></div>`);
  }
  const b = catalog.sources.benchmarks;
  if (!catalog.isSample && b.status !== 'ok') {
    const why = b.status === 'stale' ? `最新の取得に失敗したため ${fmtDate(b.fetchedAt)} 時点の値を表示しています。` : 'ベンチマーク API のキー（GitHub Secrets の OPENROUTER_API_KEY）が未設定のため、スコアがまだありません。価格の比較だけ使えます。';
    out.push(`<div class="banner info"><strong>ベンチマーク: ${esc(b.status === 'stale' ? '前回値' : '未取得')}</strong>${esc(why)}${b.status === 'stale' ? '' : '<button class="btn" id="toSample">サンプルで見た目を試す</button>'}</div>`);
  }
  $('banners').innerHTML = out.join('');
  $('toLive')?.addEventListener('click', () => switchData('live'));
  $('toSample')?.addEventListener('click', () => switchData('sample'));
}

function renderProviders() {
  if (!catalog) return;
  const present = new Set(catalog.models.map((m) => m.providerSlug));
  const list = [...MAJOR_PROVIDERS, ...EXTRA_PROVIDERS].filter((p) => present.has(p) || MAJOR_PROVIDERS.includes(p));
  $('providers').innerHTML = list
    .map((p) => `<label class="chip"><input type="checkbox" value="${esc(p)}" ${state.providers.includes(p) ? 'checked' : ''}/><span class="dot" style="background:${providerColor(p)}"></span>${esc(providerName(p))}</label>`)
    .join('');
}

function renderMetricSelect(metrics: { key: MetricKey; count: number }[]) {
  const sel = $<HTMLSelectElement>('metric');
  if (!metrics.length) {
    sel.innerHTML = `<option value="">（表示中のモデルに評価がありません）</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const p = state.metric ? parseMetricKey(state.metric) : null;
  $('metricHelp').textContent = p ? `縦軸: ${METRIC_LABELS[p.metric] ?? p.metric} — ${METRIC_HELP[p.metric] ?? ''}（${SOURCE_LABELS[p.source] ?? p.source}）` : '';
  sel.innerHTML = metrics.map((m) => `<option value="${esc(m.key)}" ${m.key === state.metric ? 'selected' : ''}>${esc(metricLabel(m.key))}（${m.count}/${visible.length}件）</option>`).join('');
}

function relModeReason(): string | null {
  const base = baseModel();
  if (!base) return '基準モデルが未選択です';
  const s = findMetric(base, state.metric)?.score ?? null;
  if (!isRatioMetric(state.metric)) return 'Elo は差で比べる尺度なので比は出しません';
  if (s === null) return '基準モデルにこの指標のスコアがありません';
  if (s === 0) return '基準モデルのスコアが 0 のため比が計算できません';
  const c = scenarioCostUsd(base, state.inTok, state.outTok);
  if (c === null) return '基準モデルの価格が不明です';
  if (c === 0) return '基準モデルの想定コストが 0 のため比が計算できません';
  return null;
}

function renderChart() {
  const el = $('chart');
  const reason = relModeReason();
  const rel = state.mode === 'rel' && reason === null;
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === (rel ? 'rel' : 'abs')));
    if (b.dataset.mode === 'rel') {
      b.disabled = reason !== null;
      b.title = reason ?? '';
    }
  });

  const noScore = rows.filter((r) => r.score === null).length;
  const noCost = rows.filter((r) => r.score !== null && r.cost === null).length;
  let pts = rows.filter((r) => r.score !== null && r.cost !== null);
  const x = (r: Row) => (rel ? (r.relCost as number) : (r.cost as number));
  const y = (r: Row) => (rel ? (r.relScore as number) : (r.score as number));
  let logDropped = 0;
  if (state.logX) {
    logDropped = pts.filter((r) => x(r) <= 0).length;
    pts = pts.filter((r) => x(r) > 0);
  }

  const notes = [`表示 ${rows.length} 件中 散布図 ${pts.length} 件`];
  if (noScore) notes.push(`未評価 ${noScore} 件（表には表示）`);
  if (noCost) notes.push(`価格不明 ${noCost} 件`);
  if (logDropped) notes.push(`対数軸のため無料 ${logDropped} 件を除外`);
  if (state.mode === 'rel' && reason) notes.push(`基準比モード不可: ${reason}`);
  const maxSpeed = Math.max(0, ...pts.map((r) => r.model.throughputTps ?? 0));
  if (maxSpeed > 0 && state.speedViz === 'bar') notes.push(`名前の下の棒 = 速度（最速 ${Math.round(maxSpeed)} tok/s を最長に）`);
  if (maxSpeed > 0 && state.speedViz === 'size') notes.push('点の大きさ = 速度（白抜き = 未取得）');
  $('chartNote').textContent = notes.join(' ・ ');

  if (!pts.length) {
    chart?.dispose();
    chart = null;
    const msg = !state.metric
      ? 'スコアのあるモデルがありません。ベンチマークデータが取得されると、ここに価格 vs 性能の散布図が出ます。'
      : 'この条件ではプロットできるモデルがありません（スコアと価格の両方が必要）。';
    el.innerHTML = `<div class="chart-empty">${esc(msg)}</div>`;
    return;
  }
  if (!chart) {
    el.innerHTML = '';
    chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.on('mouseover', (p) => hoverDetail((p.data as { id?: string } | undefined)?.id));
    chart.on('click', (p) => {
      const id = (p.data as { id?: string } | undefined)?.id;
      if (id) setBase(id);
    });
  }

  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const border = cssVar('--border');
  const surface = cssVar('--surface');
  const base = baseModel();
  const baseRow = base ? rows.find((r) => r.model.id === base.id) : undefined;

  const groups = new Map<string, Row[]>();
  for (const r of pts) {
    if (base && r.model.id === base.id) continue;
    const g = groups.get(r.model.providerSlug) ?? [];
    g.push(r);
    groups.set(r.model.providerSlug, g);
  }
  // 速度: 名前の下の棒の長さ、または点の大きさで表す（最速のモデルを最大に）
  const maxTps = Math.max(0, ...pts.map((r) => r.model.throughputTps ?? 0));
  const tpsOf = (r: Row) => (maxTps > 0 ? r.model.throughputTps : null);
  const point = (r: Row) => {
    const t = tpsOf(r);
    const c = providerColor(r.model.providerSlug);
    const item: LabelItem = { id: r.model.id, value: [x(r), y(r)], name: shortName(r.model).replace(/[{}|]/g, ''), row: r, itemStyle: { color: c } };
    if (state.speedViz === 'size') {
      item.symbolSize = t === null ? 8 : 7 + 17 * Math.sqrt(t / maxTps);
      if (t === null) item.itemStyle = { color: 'transparent', borderColor: c, borderWidth: 1.5 };
    } else if (state.speedViz === 'bar' && t !== null) {
      item.barRich = { b: { width: Math.max(3, Math.round((60 * t) / maxTps)), height: 4, backgroundColor: c, borderRadius: 2 } };
      item.label = { rich: item.barRich };
    }
    return item;
  };
  const labelText = (row: Row, name: string, prefix = '') => {
    const t = tpsOf(row);
    // 棒だけにして行の高さを抑える（数値はツールチップと表で見られる）
    return state.speedViz === 'bar' && t !== null ? `{n|${prefix}${name}}\n{b|}` : `{n|${prefix}${name}}`;
  };
  const rich = { n: { color: muted, fontSize: 11 }, v: { color: muted, fontSize: 9, padding: [0, 0, 0, 2] }, b: { height: 4, width: 0 } };
  const series: Record<string, unknown>[] = [];
  labelItems = [];
  labelBase = null;
  // 凡例用の空シリーズ（色の見本だけ）。絞り込みはメーカーのチェックで行う
  for (const slug of groups.keys()) series.push({ type: 'scatter', name: providerName(slug), data: [], itemStyle: { color: providerColor(slug) } });
  // 全モデルを 1 つのシリーズにまとめる。ラベルの重なり回避はシリーズ内でしか効かないため
  {
    const list = [...groups.values()].flat();
    labelItems = list.map(point);
    series.push({
      id: 'models',
      type: 'scatter',
      name: 'モデル',
      data: labelItems,
      symbolSize: 11,
      itemStyle: { borderColor: surface, borderWidth: 1 },
      emphasis: { focus: 'none', label: { show: true }, itemStyle: { borderColor: text, borderWidth: 2 } },
      // 名前の位置は placeLabels() が点ごとに決める（重なる場所には出さない）
      label: {
        show: false,
        position: 'right',
        color: muted,
        fontSize: 11,
        formatter: (p: { data: LabelItem }) => (p.data.joined ? `{n|${p.data.joined}}` : labelText(p.data.row, p.data.name)),
        rich,
        backgroundColor: surface,
        padding: [1, 3],
        borderRadius: 3,
      },
    });
  }
  if (state.pareto) {
    const front = pts.filter((r) => r.pareto).sort((a, b) => x(a) - x(b));
    if (front.length > 1) {
      series.push({
        type: 'line',
        name: 'パレート線',
        data: front.map((r) => [x(r), y(r)]),
        lineStyle: { color: cssVar('--good'), type: 'solid', width: 1.5, opacity: 0.7 },
        symbol: 'none',
        silent: true,
        z: 1,
        tooltip: { show: false },
      });
    }
  }
  const markLines: { xAxis?: number; yAxis?: number }[] = [];
  if (baseRow && baseRow.score !== null && baseRow.cost !== null && (!state.logX || x(baseRow) > 0)) {
    markLines.push({ xAxis: x(baseRow) }, { yAxis: y(baseRow) });
    labelBase = point(baseRow);
    series.push({
      id: 'base',
      type: 'scatter',
      name: '基準',
      data: [labelBase],
      // 基準は普通の点を少し大きく・濃い縁取りにし、十字の補助線で示す
      symbol: 'circle',
      symbolSize: 15,
      z: 10,
      itemStyle: { color: providerColor(baseRow.model.providerSlug), borderColor: text, borderWidth: 2.5 },
      label: { show: true, position: 'top', formatter: (p: { data: LabelItem }) => (p.data.joined ? `{n|基準: ${p.data.joined}}` : labelText(p.data.row, p.data.name, '基準: ')), rich: { ...rich, n: { color: text, fontWeight: 'bold', fontSize: 12 } }, backgroundColor: surface, padding: [1, 3], borderRadius: 3 },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: text, type: 'dashed', width: 1, opacity: 0.55 },
        data: markLines,
      },
    });
  }

  // 軸は常に表示中の点にぴったり合わせる（端に少しだけ余白）。拡大縮小はしない
  const pad = (log: boolean) => ({
    min: (v: { min: number; max: number }) => (log ? v.min / Math.pow(v.max / v.min, 0.04) : v.min - (v.max - v.min || Math.abs(v.min) || 1) * 0.04),
    max: (v: { min: number; max: number }) => (log ? v.max * Math.pow(v.max / v.min, 0.04) : v.max + (v.max - v.min || Math.abs(v.max) || 1) * 0.04),
  });

  // 狭い画面では軸名を短くする（トークン数は入力欄に出ているので省く）
  const narrow = el.clientWidth < 560;
  const metricShort = state.metric ? (METRIC_LABELS[parseMetricKey(state.metric).metric] ?? parseMetricKey(state.metric).metric) : '';
  const metricName = narrow ? metricShort : metricLabel(state.metric);
  const xName = rel
    ? narrow ? 'コスト比（小さいほど安い）' : 'コスト比（基準 = 1, 小さいほど安い）'
    : narrow ? '想定コスト USD' : `想定コスト USD（入力 ${state.inTok.toLocaleString()} / 出力 ${state.outTok.toLocaleString()} tok）`;
  const yName = rel ? (narrow ? 'スコア比（大きいほど高い）' : 'スコア比（基準 = 1, 大きいほど高い）') : metricName;
  chart.setOption(
    {
      animation: false,
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      legend: { top: 0, right: 0, selectedMode: false, itemWidth: 12, itemHeight: 10, textStyle: { color: text, fontSize: 12 }, data: [...groups.keys()].map(providerName).concat(baseRow ? ['基準'] : []) },
      grid: { left: 56, right: 24, top: 30, bottom: 34, containLabel: true },
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: surface,
        borderColor: border,
        textStyle: { color: text, fontSize: 12 },
        formatter: (p: { data?: { row?: Row } }) => (p.data?.row ? tooltipHtml(p.data.row) : ''),
      },
      xAxis: {
        type: state.logX ? 'log' : 'value',
        name: xName,
        nameLocation: 'middle',
        nameGap: 30,
        nameTextStyle: { color: muted },
        axisLabel: { color: muted, hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: (v: number) => (rel ? `${+v.toFixed(2)}×` : `$${+v.toPrecision(3)}`) },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, opacity: 0.6 } },
        scale: true,
        ...pad(state.logX),
      },
      yAxis: {
        type: 'value',
        name: yName,
        nameLocation: 'middle',
        nameGap: 52,
        nameTextStyle: { color: muted },
        axisLabel: { color: muted, hideOverlap: true, showMinLabel: false, showMaxLabel: false, formatter: (v: number) => (rel ? `${+v.toFixed(2)}×` : `${+v.toPrecision(4)}`) },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, opacity: 0.6 } },
        scale: true,
        ...pad(false),
      },
      series,
    },
    { notMerge: true },
  );
  // クリック直後の描き直しでマウスを乗せた状態が残らないよう、強調を解いておく
  chart.dispatchAction({ type: 'downplay', seriesIndex: series.map((_, i) => i) });
  placeLabels();
}

// ---------- 名前の配置 ----------
type LabelItem = Record<string, unknown> & { value: number[]; name: string; row: Row; symbolSize?: number; barRich?: unknown; joined?: string };
let labelItems: LabelItem[] = [];
let labelBase: LabelItem | null = null;
let measureCanvas: HTMLCanvasElement | null = null;

function textWidth(text: string, font: string): number {
  measureCanvas ??= document.createElement('canvas');
  const c = measureCanvas.getContext('2d');
  if (!c) return text.length * 7;
  c.font = font;
  return c.measureText(text).width;
}

/**
 * 点ごとに右・左・上・下などの候補を順に試し、ほかの名前・点と重ならず、
 * グラフの枠に収まる位置に名前を置く。どこにも置けない名前は出さない（マウスを乗せれば出る）。
 * 基準 → パレート上 → スコアの高い順に優先する。拡大・移動のたびに置き直す。
 */
function placeLabels() {
  if (!chart) return;
  let rect: { x: number; y: number; width: number; height: number };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rect = (chart as any).getModel().getComponent('grid', 0).coordinateSystem.getRect();
  } catch {
    return;
  }
  const family = getComputedStyle(document.body).fontFamily;
  const all = (labelBase ? [labelBase] : []).concat(labelItems);
  const px = new Map<LabelItem, number[]>();
  for (const it of all) px.set(it, chart.convertToPixel({ gridIndex: 0 }, it.value) as number[]);
  const sizeOf = (it: LabelItem) => (typeof it.symbolSize === 'number' ? it.symbolSize : it === labelBase ? 15 : 11);
  const inRect = (b: Box) => b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.width && b.y + b.h <= rect.y + rect.height;
  type Box = { x: number; y: number; w: number; h: number; owner?: LabelItem };
  const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // 点そのものも障害物にする（名前で点を隠さない）
  const boxes: Box[] = [];
  for (const it of all) {
    const [x, y] = px.get(it)!;
    const r = sizeOf(it) / 2;
    boxes.push({ x: x - r, y: y - r, w: r * 2, h: r * 2, owner: it });
  }
  const want = (it: LabelItem) => it === labelBase || state.labels === 'all' || (state.labels === 'pareto' && it.row.pareto);
  const order = all.filter(want).sort((a, b) => {
    const pa = a === labelBase ? 0 : a.row.pareto ? 1 : 2;
    const pb = b === labelBase ? 0 : b.row.pareto ? 1 : 2;
    return pa - pb || (px.get(a)![1] - px.get(b)![1]);
  });
  // ほぼ同じ位置の点（10px 以内＝点どうしが重なる）は 1 つの名前に併記する（例: 「A / B」）
  const leaders: LabelItem[] = [];
  const members = new Map<LabelItem, LabelItem[]>();
  for (const it of order) {
    const [x, y] = px.get(it)!;
    const lead = leaders.find((l) => {
      const [lx, ly] = px.get(l)!;
      return Math.abs(lx - x) <= 10 && Math.abs(ly - y) <= 10;
    });
    if (lead) members.get(lead)!.push(it);
    else {
      leaders.push(it);
      members.set(it, [it]);
    }
  }
  for (const it of all) delete it.joined;
  const placed = new Set<LabelItem>();
  for (const it of leaders) {
    const [x, y] = px.get(it)!;
    const isBase = it === labelBase;
    const group = members.get(it)!;
    const names = group.map((g) => g.name);
    const joined = names.length > 3 ? `${names.slice(0, 3).join(' / ')} 他${names.length - 3}` : names.join(' / ');
    if (group.length > 1) it.joined = joined;
    const text = (isBase ? '基準: ' : '') + joined;
    const w = textWidth(text, `${isBase ? 'bold 12px' : '11px'} ${family}`) + 7;
    const hasBar = group.length === 1 && state.speedViz === 'bar' && !!it.barRich;
    const h = (isBase ? 17 : 15) + (hasBar ? 6 : 0);
    const r = sizeOf(it) / 2 + 3;
    const cands: [number, number][] = [
      [x + r, y - h / 2], // 右
      [x - r - w, y - h / 2], // 左
      [x - w / 2, y - r - h], // 上
      [x - w / 2, y + r], // 下
      [x + r, y - h - 1], // 右上
      [x + r, y + 1], // 右下
      [x - r - w, y - h - 1], // 左上
      [x - r - w, y + 1], // 左下
    ];
    if (isBase) cands.unshift(cands.splice(2, 1)[0]); // 基準は上を優先
    const s = sizeOf(it);
    let ok: Box | null = null;
    for (const [bx, by] of cands) {
      const b: Box = { x: bx, y: by, w, h };
      if (inRect(b) && !boxes.some((o) => o.owner !== it && hit(b, o))) {
        ok = b;
        break;
      }
    }
    if (ok) {
      boxes.push(ok);
      for (const g of group) placed.add(g);
      // position は点の外接矩形の左上からの相対
      it.label = { rich: it.barRich ?? {}, show: true, position: [ok.x - (x - s / 2), ok.y - (y - s / 2)], align: 'left', verticalAlign: 'top' };
    } else if (isBase) {
      it.label = { rich: it.barRich ?? {}, show: true, position: 'top' };
    }
  }
  for (const it of labelItems) if (!placed.has(it)) it.label = { rich: it.barRich ?? {}, show: false };
  const upd: Record<string, unknown>[] = [{ id: 'models', data: labelItems }];
  if (labelBase) upd.push({ id: 'base', data: [labelBase] });
  chart.setOption({ series: upd });
  const hidden = order.filter((it) => !placed.has(it)).length;
  const note = $('labelNote');
  if (note) note.textContent = hidden > 0 ? `名前が重なるため ${hidden} 件は省略（点にマウスを乗せると見られます）` : '';
}

function tooltipHtml(r: Row): string {
  const m = r.model;
  const isBase = m.id === state.base;
  return `<div style="min-width:220px">
    <div style="font-weight:700;margin-bottom:2px">${esc(shortName(m))}${isBase ? '（基準）' : ''}</div>
    <div style="opacity:.75;margin-bottom:6px">${esc(providerName(m.providerSlug))} ・ ${esc(m.id)}</div>
    入力 $${fmtNum(m.inputUsdPerMillion, 3)} / 出力 $${fmtNum(m.outputUsdPerMillion, 3)}（100万tok）<br>
    想定コスト <b>${fmtUsd(r.cost)}</b> ・ コスト比 <b>${fmtRatio(r.relCost)}</b><br>
    スコア <b>${fmtNum(r.score, 2)}</b> ・ スコア比 <b>${fmtRatio(r.relScore)}</b><br>
    コスト効率比 ${fmtRatio(r.relEfficiency)}${r.pareto ? ' ・ パレート最適' : ''}<br>
    <span style="opacity:.75">評価: ${esc(SOURCE_LABELS[r.metric?.source ?? ''] ?? r.metric?.source ?? 'N/A')} ・ ${esc(fmtDay(r.metric?.evaluatedAt))}</span><br>
    <span style="opacity:.75">クリックで基準に設定</span>
  </div>`;
}

function renderBaseCard() {
  const el = $('baseCard');
  const base = baseModel();
  if (!base) {
    el.innerHTML = `<div class="label-small">基準モデル</div><p>未選択です。散布図の点か、表の行をクリックして選んでください。</p>`;
    return;
  }
  const cost = scenarioCostUsd(base, state.inTok, state.outTok);
  const metric = findMetric(base, state.metric);
  const outside = !visible.some((m) => m.id === base.id);
  el.innerHTML = `<div class="label-small">基準モデル（= 1.00×）</div>
    <div class="model-title"><span class="dot" style="background:${providerColor(base.providerSlug)}"></span><h3>${esc(shortName(base))}</h3></div>
    <div class="model-id">${esc(base.id)}</div>
    <div class="stats">
      <div class="stat s-score" title="${esc(metricLabel(state.metric))}"><span class="k">${ICON.score}スコア</span><span class="v">${metric ? fmtNum(metric.score, 2) : 'N/A'}</span></div>
      <div class="stat s-cost"><span class="k">${ICON.cost}想定コスト</span><span class="v">${fmtUsd(cost)}</span></div>
      <div class="stat s-price"><span class="k">${ICON.price}単価 入/出 (100万tok)</span><span class="v">$${fmtNum(base.inputUsdPerMillion, 2)} / $${fmtNum(base.outputUsdPerMillion, 2)}</span></div>
      <div class="stat s-speed"><span class="k">${ICON.speed}速度 / ${ICON.latency}遅延</span><span class="v">${base.throughputTps !== null ? `${fmtNum(base.throughputTps, 0)}<span class="u">tok/s</span>` : '未取得'}${base.latencySeconds !== null ? ` <span class="u">/ ${fmtNum(base.latencySeconds, 2)} s</span>` : ''}</span></div>
    </div>
    ${outside ? '<div class="warn-inline">基準モデルは現在のフィルタ外です（設定は保持しています）。</div>' : ''}`;
}

function bar(label: string, v: number | null, better: 'high' | 'low', icon = '') {
  const max = 3;
  const w = v === null ? 0 : Math.min(v, max) / max;
  const cls = v === null || Math.abs(v - 1) < 0.005 ? 'na' : (v > 1) === (better === 'high') ? 'good' : 'bad';
  return `<div class="bar-row"><span>${icon}${label}<span class="hint-dir">${better === 'high' ? '↑良' : '↓良'}</span></span>
    <div class="bar-track"><div class="bar-fill" style="width:${(w * 100).toFixed(1)}%;${v === null ? '' : `background:var(--${cls === 'na' ? 'neutral' : cls})`}"></div><div class="bar-one" style="left:${(100 / max).toFixed(2)}%"></div></div>
    <span class="bar-val ${cls}">${fmtRatio(v)}</span></div>`;
}

function renderDetail() {
  const el = $('detail');
  const id = state.detail ?? state.base;
  const m = catalog?.models.find((x) => x.id === id);
  if (!m) {
    el.innerHTML = `<div class="label-small">モデル詳細</div><p class="na">散布図の点や表の行にマウスを乗せると、ここに詳細が出ます。</p>`;
    return;
  }
  const r = rows.find((x) => x.model.id === m.id) ?? buildRows([m], baseModel(), state.metric, state.inTok, state.outTok)[0];
  const metrics = [...m.metrics].sort((a, b) => a.metric.localeCompare(b.metric));
  el.innerHTML = `<div class="detail-head"><span class="label-small">モデル詳細</span>${m.id !== state.base ? `<button class="btn" id="detailSetBase">これを基準にする</button>` : '<span class="tag base">基準</span>'}</div>
    <div class="model-title"><span class="dot" style="background:${providerColor(m.providerSlug)}"></span><h3>${esc(shortName(m))}</h3></div>
    <div class="model-id">${esc(m.id)}</div>
    <dl class="kv">
      <dt>メーカー</dt><dd>${esc(providerName(m.providerSlug))}</dd>
      <dt>登録日</dt><dd>${esc(fmtDay(m.createdAt))}</dd>
      <dt>入力 / 出力</dt><dd>$${fmtNum(m.inputUsdPerMillion, 3)} / $${fmtNum(m.outputUsdPerMillion, 3)}</dd>
      <dt>想定コスト</dt><dd>${fmtUsd(r.cost)}</dd>
      <dt>コンテキスト</dt><dd>${m.contextLength !== null ? m.contextLength.toLocaleString() : 'N/A'}</dd>
      <dt>速度 / 遅延</dt><dd>${m.throughputTps !== null ? `${fmtNum(m.throughputTps, 0)} tok/s` : '未取得'} / ${m.latencySeconds !== null ? `${fmtNum(m.latencySeconds, 2)} s` : '未取得'}</dd>
      <dt>利用量</dt><dd>${usageText(m.usage)}</dd>
      ${m.usage?.codeRank ? `<dt>コーディング</dt><dd>#${m.usage.codeRank}（${fmtTok(m.usage.codeTokens)} / 週・推定）</dd>` : ''}
      ${m.hiddenReasons.length ? `<dt>既定で非表示</dt><dd>${esc(m.hiddenReasons.join(', '))}</dd>` : ''}
    </dl>
    ${m.usage && m.usage.daily.some((v) => v > 0) ? `<div class="label-small" style="margin-top:8px">${ICON.usage}OpenRouter での利用量（日ごと、直近 ${m.usage.daily.length} 日）</div>${sparkline(m.usage.daily)}` : ''}
    <div class="label-small" style="margin-top:10px">基準比（縦線 = 1.00×、緑 = 基準より良い）</div>
    <div class="bars" aria-label="基準比（縦線 = 1.00×）">
      ${bar('スコア', r.relScore, 'high', ICON.score)}
      ${bar('コスト', r.relCost, 'low', ICON.cost)}
      ${bar('効率', r.relEfficiency, 'high', ICON.eff)}
      ${bar('速度', r.relSpeed, 'high', ICON.speed)}
      ${bar('遅延', r.relLatency, 'low', ICON.latency)}
    </div>
    <div class="label-small" style="margin-top:10px">評価スコア（${metrics.length}）</div>
    ${metrics.length ? `<ul class="metric-list">${metrics.map((x) => `<li class="${metricKeyOf(x) === state.metric ? 'on' : ''}"><span>${esc(METRIC_LABELS[x.metric] ?? x.metric)}<span class="src">${esc(SOURCE_LABELS[x.source] ?? x.source)}${x.version ? ` ${esc(x.version)}` : ''} ・ ${esc(fmtDay(x.evaluatedAt))}</span></span><b>${fmtNum(x.score, 2)}</b></li>`).join('')}</ul>` : '<p class="na">未評価</p>'}
`;
  $('detailSetBase')?.addEventListener('click', () => setBase(m.id));
}

function usageText(u: Usage | null | undefined) {
  if (!hasRankings()) return '<span class="na">未取得</span>';
  if (!u || !u.rank7d) return '<span class="na">上位 50 圏外</span>';
  return `<b>#${u.rank7d}</b> ・ ${fmtTok(u.tokens7d)} tok / 7日${u.share7d !== null ? `（全体の ${(u.share7d * 100).toFixed(1)}%）` : ''} ${trendHtml(usageTrend(u))}`;
}

// 量の種類ごとの小さなアイコン（色は CSS の .ic-* で付ける）
const svg = (cls: string, d: string) => `<svg class="ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
const ICON = {
  score: svg('ic-score', '<path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.4L8 11.2 4.1 13.4l.9-4.4-3.3-3 4.4-.5z" fill="currentColor"/>'),
  cost: svg('ic-cost', '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.2 5.6c-.4-.6-1.2-1-2.2-1-1.3 0-2.2.7-2.2 1.6 0 2.2 4.5 1.2 4.5 3.5 0 1-1 1.7-2.3 1.7-1.1 0-1.9-.4-2.3-1.1M8 3.4v1.2M8 11.4v1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'),
  price: svg('ic-price', '<path d="M2 8.5V3h5.5L14 9.5 8.5 15z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="5" cy="6" r="1.2" fill="currentColor"/>'),
  eff: svg('ic-eff', '<path d="M2 13l4-4 3 2.5L14 5M10.5 5H14v3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  speed: svg('ic-speed', '<path d="M9 1L3 9h4.5L6.5 15 13 6.5H8.5z" fill="currentColor"/>'),
  latency: svg('ic-lat', '<circle cx="8" cy="9" r="5.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5.8V9l2 1.6M6.3 1.5h3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
  usage: svg('ic-use', '<path d="M2.5 14V9.5M6.2 14V6M9.8 14V8M13.5 14V2.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  date: svg('ic-date', '<rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'),
};
const COL_ICON: Partial<Record<string, string>> = {
  score: ICON.score, relScore: ICON.score, cost: ICON.cost, relCost: ICON.cost, relEfficiency: ICON.eff,
  speed: ICON.speed, relSpeed: ICON.speed, latency: ICON.latency, relLatency: ICON.latency, usage: ICON.usage, created: ICON.date,
};

// 値の列は基準比も同じセルに出す（並べ替えの順は値でも比でも同じ）
const BASE_COLUMNS: { key: SortKey; label: string; cls?: string; title?: string }[] = [
  { key: 'name', label: 'モデル', cls: 'l col-model', title: '色の点 = メーカー' },
  { key: 'score', label: 'スコア ／ 比', title: '選んでいる評価指標の値と基準比。高いほど良い（数値の比であり知能の倍率ではない）' },
  { key: 'cost', label: '想定コスト ／ 比', title: '想定コストと基準比。低いほど安い' },
  { key: 'relEfficiency', label: '効率比', title: 'コスト効率（スコア ÷ 想定コスト）の基準比。高いほど効率的' },
  { key: 'speed', label: '速度 ／ 比', title: '出力速度と基準比。高いほど速い' },
  { key: 'latency', label: '遅延 ／ 比', title: '最初の応答までの時間と基準比。低いほど良い' },
  { key: 'usage', label: '利用量', title: 'OpenRouter での直近 7 日の利用トークン数と順位（上位 50 のみ）。▲▼ は前の 7 日との比較' },
  { key: 'created', label: '登録日' },
];

/** 選択中の指標の列のあとに、用途別の主な指標の比を並べる */
function columns() {
  const extra = keyMetricKeys.filter((k) => k.key !== state.metric).map((k) => ({ key: `m:${k.key}` as SortKey, label: k.label, cls: '', title: `${k.title}。高いほど良い` }));
  const i = BASE_COLUMNS.findIndex((c) => c.key === 'relEfficiency') + 1;
  return [...BASE_COLUMNS.slice(0, i), ...extra, ...BASE_COLUMNS.slice(i)];
}

function sortValue(r: Row, k: SortKey): number | string | null {
  if (k.startsWith('m:')) return keyRatio(r.model, k.slice(2));
  switch (k) {
    case 'provider': return providerName(r.model.providerSlug);
    case 'name': return shortName(r.model).toLowerCase();
    case 'score': return r.score;
    case 'relScore': return r.relScore;
    case 'cost': return r.cost;
    case 'relCost': return r.relCost;
    case 'relEfficiency': return r.relEfficiency;
    case 'speed': return r.model.throughputTps;
    case 'relSpeed': return r.relSpeed;
    case 'latency': return r.model.latencySeconds;
    case 'relLatency': return r.relLatency;
    case 'usage': return r.model.usage?.rank7d ? r.model.usage.tokens7d : null;
    case 'created': return r.model.createdAt;
  }
  return null;
}

function sortedRows(): Row[] {
  const list = [...rows].sort((a, b) => {
    const va = sortValue(a, state.sortKey);
    const vb = sortValue(b, state.sortKey);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // N/A は常に末尾
    if (vb === null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.sortDir;
  });
  if (state.pinBase && state.base) {
    const i = list.findIndex((r) => r.model.id === state.base);
    if (i > 0) list.unshift(...list.splice(i, 1));
  }
  return list;
}

/** 値と基準比を 1 セルに。比は色付きの小さな札で出す */
function pairCell(val: string, v: number | null, better: 'high' | 'low', raw: string, dbAttr: string) {
  let r = '<span class="r na">N/A</span>';
  if (v !== null) {
    const same = Math.abs(v - 1) < 0.005;
    const cls = same ? 'na' : (v > 1) === (better === 'high') ? 'good' : 'bad';
    r = `<span class="r ${cls}">${same ? '＝' : v > 1 ? '▲' : '▼'}${fmtRatio(v)}</span>`;
  }
  return `<td title="${esc(raw)}"${dbAttr}><span class="pv2">${val}</span>${r}</td>`;
}
/** 並べ替えの見出し: 比の列は値の列に寄せて表示する */
const SORT_ALIAS: Partial<Record<string, string>> = { relScore: 'score', relCost: 'cost', relSpeed: 'speed', relLatency: 'latency', provider: 'name' };

function ratioCell(v: number | null, better: 'high' | 'low', raw: string) {
  if (v === null) return `<td class="na" title="計算できません">N/A</td>`;
  const same = Math.abs(v - 1) < 0.005;
  const good = (v > 1) === (better === 'high');
  const cls = same ? 'na' : good ? 'good' : 'bad';
  const arrow = same ? '＝' : v > 1 ? '▲' : '▼';
  return `<td class="${cls}" title="${esc(raw)}">${arrow} ${fmtRatio(v)}</td>`;
}

function renderTable() {
  const list = sortedRows();
  const base = baseModel();
  const cols = columns();
  const extraKeys = cols.filter((c) => c.key.startsWith('m:')).map((c) => c.key.slice(2));
  const maxOf = (f: (r: Row) => number | null) => Math.max(0, ...list.map((r) => f(r) ?? 0));
  const mScore = maxOf((r) => r.score);
  const mCost = maxOf((r) => r.cost);
  const mTps = maxOf((r) => r.model.throughputTps);
  const mLat = maxOf((r) => r.model.latencySeconds);
  const mUse = maxOf((r) => r.model.usage?.tokens7d ?? null);
  const ranked = hasRankings();
  const db = (v: number | null, max: number, kind: string) => (v === null || max <= 0 ? '' : ` class="db db-${kind}" style="--w:${Math.max(2, (100 * v) / max).toFixed(1)}%"`);
  const head = `<thead><tr>${cols.map((c) => `<th class="${c.cls ?? ''}" data-key="${c.key}" ${c.title ? `title="${esc(c.title)}"` : ''} aria-sort="${(SORT_ALIAS[state.sortKey] ?? state.sortKey) === c.key ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none'}" tabindex="0">${COL_ICON[c.key] ?? ''}${c.label}</th>`).join('')}</tr></thead>`;
  const body = list
    .map((r) => {
      const m = r.model;
      const isBase = base?.id === m.id;
      const src = r.metric ? `${SOURCE_LABELS[r.metric.source] ?? r.metric.source} ・ ${fmtDay(r.metric.evaluatedAt)}` : '未評価';
      return `<tr data-id="${esc(m.id)}" class="${isBase ? 'is-base' : ''} ${state.detail === m.id ? 'is-detail' : ''}">
        <td class="l col-model" title="${esc(providerName(m.providerSlug))} ・ ${esc(m.id)}"><span class="dot" style="background:${providerColor(m.providerSlug)}"></span><button type="button" class="model-btn" data-base="${esc(m.id)}" title="クリックで基準に設定">${esc(shortName(m))}</button>${isBase ? '<span class="tag base">基準</span>' : ''}${r.pareto ? '<span class="tag pareto" title="パレート線（お得の境界）の上">P</span>' : ''}</td>
        ${pairCell(r.score === null ? '<span class="na">未評価</span>' : fmtNum(r.score, 2), r.relScore, 'high', `${src}。${fmtNum(r.score, 4)} ÷ ${fmtNum(base ? findMetric(base, state.metric)?.score ?? null : null, 4)}`, db(r.score, mScore, 'score'))}
        ${pairCell(fmtUsd(r.cost), r.relCost, 'low', `入力 $${fmtNum(m.inputUsdPerMillion, 4)} / 出力 $${fmtNum(m.outputUsdPerMillion, 4)} per 100万tok。${fmtUsd(r.cost)} ÷ ${fmtUsd(base ? scenarioCostUsd(base, state.inTok, state.outTok) : null)}`, db(r.cost, mCost, 'cost'))}
        ${ratioCell(r.relEfficiency, 'high', r.scorePerDollar === null ? 'スコア/ドルが定義できません' : `スコア/ドル = ${r.scorePerDollar.toFixed(3)}`)}
        ${extraKeys.map((k) => ratioCell(keyRatio(m, k), 'high', `${fmtNum(findMetric(m, k)?.score ?? null, 3)} ÷ ${fmtNum(base ? findMetric(base, k)?.score ?? null : null, 3)}`)).join('')}
        ${pairCell(m.throughputTps !== null ? `${fmtNum(m.throughputTps, 0)}<span class="u">tok/s</span>` : '<span class="na">未取得</span>', r.relSpeed, 'high', `${fmtNum(m.throughputTps, 1)} tok/s`, db(m.throughputTps, mTps, 'speed'))}
        ${pairCell(m.latencySeconds !== null ? `${fmtNum(m.latencySeconds, 2)}<span class="u">s</span>` : '<span class="na">未取得</span>', r.relLatency, 'low', `${fmtNum(m.latencySeconds, 3)} s`, db(m.latencySeconds, mLat, 'lat'))}
        <td${db(m.usage?.rank7d ? m.usage.tokens7d : null, mUse, 'use')}>${m.usage?.rank7d ? `<span class="rank">#${m.usage.rank7d}</span>${fmtTok(m.usage.tokens7d)}${trendHtml(usageTrend(m.usage))}` : `<span class="na">${ranked ? '圏外' : '未取得'}</span>`}</td>
        <td>${esc(fmtDay(m.createdAt))}</td>
      </tr>`;
    })
    .join('');
  $('table').innerHTML = head + `<tbody>${body || `<tr><td colspan="${cols.length}" class="l na">条件に合うモデルがありません。</td></tr>`}</tbody>`;
  fitTableRows();
}

/** 表の行の高さを、全行が枠に収まるように詰める（詰めすぎると読めないので下限あり。超えたら枠内でスクロール） */
function fitTableRows() {
  const sc = document.querySelector<HTMLElement>('.table-scroll');
  const t = $('table') as HTMLTableElement;
  const n = t.tBodies[0]?.rows.length ?? 0;
  if (!sc || !n) return;
  const avail = sc.clientHeight - (t.tHead?.offsetHeight ?? 0) - 2;
  const h = Math.max(17, Math.min(30, Math.floor(avail / n) - 1)); // -1 = 行の下線
  t.style.setProperty('--rowh', `${h}px`);
  t.classList.toggle('dense', h < 23);
  t.classList.toggle('xdense', h < 20);
}

function renderRankSource() {
  const k = catalog?.sources.rankings;
  if (!k || k.status === 'none') return '';
  if (k.status !== 'ok' && k.status !== 'stale') return `<p>利用量: 未取得（${esc(k.error ?? k.status)}）</p>`;
  const days = k.days.length ? `${k.days[0]} 〜 ${k.days[k.days.length - 1]}` : '';
  return `<p>利用量: <a href="https://openrouter.ai/docs/api/api-reference/datasets/get-rankings-daily" target="_blank" rel="noopener">OpenRouter Rankings API</a>（日ごとの上位 50 モデルの入出力トークン数。${esc(days)}。<code>:free</code> などの変種は合算。コーディングは programming 用途の ${esc(k.codeWeek ?? '')} 週の推定値）。トークン数はメーカーごとの数え方で、モデル間で厳密には比べられません。${k.status === 'stale' ? '今回は取得に失敗したため前回の値です。' : ''} Source: OpenRouter (openrouter.ai/rankings), as of ${esc(k.asOf ?? k.fetchedAt ?? '')}. Licensed under CC BY 4.0.</p>`;
}

function renderFooter() {
  if (!catalog) return;
  const b = catalog.sources.benchmarks;
  const aa = b.metas?.find((m) => m.source === 'artificial-analysis');
  $('footer').innerHTML = `
    <h3>出典とライセンス</h3>
    <p>モデル・価格: <a href="https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties" target="_blank" rel="noopener">OpenRouter Models API</a>（${esc(fmtDate(catalog.fetchedAt))} 取得）。価格は OpenRouter 経由の表示価格で、開発元と直接契約したときの価格とは異なる場合があります。</p>
    <p>ベンチマーク: <a href="https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks" target="_blank" rel="noopener">OpenRouter Benchmarks API</a>${aa ? `（Artificial Analysis 指標は <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">Artificial Analysis</a> による。as of ${esc(fmtDate(aa.asOf))}${aa.citation ? ` ・ ${esc(aa.citation)}` : ''}）` : ''}。Source: OpenRouter Data API (openrouter.ai/docs/cookbook/administration/data-api), as of ${esc(b.fetchedAt ?? catalog.fetchedAt)}. Licensed under CC BY 4.0.${b.metas?.some((m) => m.source === 'design-arena') ? ' Design Arena の値は <a href="https://www.designarena.ai/" target="_blank" rel="noopener">Design Arena</a> による。' : ''}</p>
    ${renderRankSource()}
    <p>照合: ベンチマーク ${catalog.stats.benchmarkRecords} 件中 ${catalog.stats.benchmarkMatched} 件をモデル ID で照合。未一致 ${catalog.stats.benchmarkUnmatchedSlugs.length} 種（表示名では照合しません）。</p>
    <h3>計算方法</h3>
    <p>想定コスト = 入力単価 × 入力トークン ÷ 100万 + 出力単価 × 出力トークン ÷ 100万。各比 = 対象の値 ÷ 基準の値。基準が 0 / 不明のときは N/A。パレート最適 = スコアが同等以上かつコストが同等以下で、どちらかが厳密に良い他モデルが存在しないもの。</p>
    <h3>限界</h3>
    <p>指標・出典・版が違うスコアは混ぜません。速度・遅延は OpenRouter エンドポイントの直近 30 分の中央値（取得できたもののみ）。「最新」はモデルの登録日であり、データの取得時刻とは別です。</p>`;
}

// ---------- 操作 ----------
function setBase(id: string) {
  if (state.base === id) return;
  state.base = id;
  state.detail = id;
  recompute();
}

/** マウスを乗せたモデルを右の詳細に出す（表は作り直さず、強調の行だけ付け替える） */
function hoverDetail(id: string | undefined) {
  if (!id || state.detail === id) return;
  state.detail = id;
  renderDetail();
  $('table').querySelectorAll('tr.is-detail').forEach((tr) => tr.classList.remove('is-detail'));
  $('table').querySelector(`tr[data-id="${CSS.escape(id)}"]`)?.classList.add('is-detail');
}

let busyTimer = 0;
/** すぐに「更新中」を表示してから、ブラウザに一度描かせたあとで重い処理を走らせる */
function withBusy(msg: string, fn: () => void) {
  const badge = $('busy');
  badge.textContent = msg;
  badge.hidden = false;
  document.body.classList.add('is-busy');
  clearTimeout(busyTimer);
  requestAnimationFrame(() => {
    busyTimer = window.setTimeout(() => {
      try {
        fn();
      } finally {
        badge.hidden = true;
        document.body.classList.remove('is-busy');
      }
    }, 0);
  });
}

async function switchData(d: 'live' | 'sample') {
  state.data = d;
  state.base = null;
  state.metric = null;
  await start();
}

function bindControls() {
  $('resetBtn').addEventListener('click', resetView);
  $('picks').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-base]')?.dataset.base;
    if (id) setBase(id);
  });
  $('picks').addEventListener('mouseover', (e) => hoverDetail((e.target as HTMLElement).closest<HTMLElement>('[data-base]')?.dataset.base));
  $('providers').addEventListener('change', () => {
    state.providers = [...document.querySelectorAll<HTMLInputElement>('#providers input:checked')].map((i) => i.value);
    recompute();
  });
  $<HTMLSelectElement>('metric').addEventListener('change', (e) => {
    state.metric = (e.target as HTMLSelectElement).value || null;
    recompute();
  });
  const tok = (id: 'inTok' | 'outTok') => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener('input', () => {
      const n = Number(el.value);
      if (el.value.trim() === '' || !Number.isFinite(n) || n < 0) return;
      state[id] = Math.floor(n);
      recompute();
    });
  };
  tok('inTok');
  tok('outTok');
  $<HTMLSelectElement>('usage').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    customTok = v === 'custom';
    if (!customTok) [state.inTok, state.outTok] = v.split(':').map(Number);
    syncInputs();
    recompute();
  });
  $<HTMLSelectElement>('age').addEventListener('change', (e) => { state.ageMonths = Number((e.target as HTMLSelectElement).value); recompute(); });
  $<HTMLSelectElement>('scope').addEventListener('change', (e) => { state.scope = (e.target as HTMLSelectElement).value as State['scope']; recompute(); });
  $<HTMLSelectElement>('max').addEventListener('change', (e) => { state.maxCount = Number((e.target as HTMLSelectElement).value); recompute(); });
  $<HTMLSelectElement>('order').addEventListener('change', (e) => { state.order = (e.target as HTMLSelectElement).value as State['order']; recompute(); });
  let t: number | undefined;
  $<HTMLInputElement>('query').addEventListener('input', (e) => {
    clearTimeout(t);
    t = window.setTimeout(() => { state.query = (e.target as HTMLInputElement).value; recompute(); }, 150);
  });
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
    b.addEventListener('click', () => { state.mode = b.dataset.mode as State['mode']; recompute(); }),
  );
  $<HTMLInputElement>('logX').addEventListener('change', (e) => { state.logX = (e.target as HTMLInputElement).checked; recompute(); });
  $<HTMLInputElement>('pareto').addEventListener('change', (e) => { state.pareto = (e.target as HTMLInputElement).checked; recompute(); });
  $<HTMLSelectElement>('labels').addEventListener('change', (e) => { state.labels = (e.target as HTMLSelectElement).value as State['labels']; recompute(); });
  $<HTMLSelectElement>('speedViz').addEventListener('change', (e) => { state.speedViz = (e.target as HTMLSelectElement).value as State['speedViz']; recompute(); });
  $<HTMLInputElement>('pinBase').addEventListener('change', (e) => { state.pinBase = (e.target as HTMLInputElement).checked; renderTable(); });

  const table = $('table');
  const sortBy = (key: SortKey) => {
    if (state.sortKey === key) state.sortDir = state.sortDir === 1 ? -1 : 1;
    else {
      state.sortKey = key;
      state.sortDir = ['provider', 'name', 'cost', 'relCost', 'latency', 'relLatency'].includes(key) ? 1 : -1;
    }
    renderTable();
  };
  table.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const th = target.closest('th');
    if (th?.dataset.key) return sortBy(th.dataset.key as SortKey);
    const btn = target.closest<HTMLElement>('[data-base]');
    if (btn?.dataset.base) return setBase(btn.dataset.base);
    // 行のどこをクリックしても基準にする（詳細はマウスを乗せるだけで出る）
    const tr = target.closest<HTMLElement>('tr[data-id]');
    if (tr?.dataset.id) setBase(tr.dataset.id);
  });
  table.addEventListener('mouseover', (e) => hoverDetail((e.target as HTMLElement).closest<HTMLElement>('tr[data-id]')?.dataset.id));
  table.addEventListener('keydown', (e) => {
    const th = (e.target as HTMLElement).closest('th');
    if (th?.dataset.key && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      sortBy(th.dataset.key as SortKey);
    }
  });
  $('csv').addEventListener('click', exportCsv);

  let rt: number | undefined;
  window.addEventListener('resize', () => {
    chart?.resize();
    fitTableRows();
    clearTimeout(rt);
    rt = window.setTimeout(renderChart, 150); // 幅の境目をまたいだら軸名を描き直す
  });
}

let customTok = false;
function syncInputs() {
  $<HTMLInputElement>('inTok').value = String(state.inTok);
  $<HTMLInputElement>('outTok').value = String(state.outTok);
  // 入出力トークンは「使い方の想定」から選ぶ。どれにも当たらない値や「自分で入力」のときだけ数値欄を出す
  const usage = $<HTMLSelectElement>('usage');
  const preset = `${state.inTok}:${state.outTok}`;
  const isPreset = [...usage.options].some((o) => o.value === preset);
  if (!isPreset) customTok = true;
  usage.value = customTok ? 'custom' : preset;
  $('tokPair').hidden = !customTok;
  $('usageNote').textContent = customTok ? '' : `入力 ${state.inTok.toLocaleString()} / 出力 ${state.outTok.toLocaleString()} トークン分の料金で比べます`;
  const setSel = (id: string, v: string) => {
    const s = $<HTMLSelectElement>(id);
    if (![...s.options].some((o) => o.value === v)) s.add(new Option(v === '0' ? 'すべて' : v, v));
    s.value = v;
  };
  setSel('age', String(state.ageMonths));
  setSel('max', String(state.maxCount));
  setSel('order', state.order);
  $<HTMLSelectElement>('scope').value = state.scope;
  $<HTMLInputElement>('pinBase').checked = state.pinBase;
  $<HTMLInputElement>('query').value = state.query;
  $<HTMLInputElement>('logX').checked = state.logX;
  $<HTMLInputElement>('pareto').checked = state.pareto;
  $<HTMLSelectElement>('labels').value = state.labels;
  $<HTMLSelectElement>('speedViz').value = state.speedViz;
}

function exportCsv() {
  const base = baseModel();
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? 'N/A' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v: number | null, d = 4) => (v === null ? null : +v.toFixed(d));
  const header = ['provider', 'model_id', 'model_name', 'metric', 'metric_source', 'evaluated_at', 'score', 'relative_score', 'input_usd_per_million', 'output_usd_per_million', 'scenario_cost_usd', 'relative_cost', 'relative_efficiency', 'throughput_tps', 'relative_speed', 'latency_s', 'relative_latency', 'is_base', 'pareto', 'usage_rank_7d', 'usage_tokens_7d', 'usage_prev_7d', 'code_rank_week', ...keyMetricKeys.map((k) => `relative_${parseMetricKey(k.key).metric}`)];
  const lines = [
    `# base=${base?.id ?? 'none'} input_tokens=${state.inTok} output_tokens=${state.outTok} metric=${state.metric ?? 'none'} data_fetched_at=${catalog?.fetchedAt ?? ''}${catalog?.isSample ? ' SAMPLE_DATA' : ''}`,
    header.join(','),
    ...sortedRows().map((r) =>
      [providerName(r.model.providerSlug), r.model.id, shortName(r.model), r.metric?.metric, r.metric?.source, r.metric?.evaluatedAt, r.score, num(r.relScore), r.model.inputUsdPerMillion, r.model.outputUsdPerMillion, num(r.cost, 6), num(r.relCost), num(r.relEfficiency), r.model.throughputTps, num(r.relSpeed), r.model.latencySeconds, num(r.relLatency), base?.id === r.model.id, r.pareto, r.model.usage?.rank7d ?? null, r.model.usage?.tokens7d ?? null, r.model.usage?.prev7d ?? null, r.model.usage?.codeRank ?? null, ...keyMetricKeys.map((k) => num(keyRatio(r.model, k.key)))]
        .map(cell)
        .join(','),
    ),
  ];
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ai-model-comparison-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 起動 ----------
async function start() {
  try {
    catalog = toPercent(await load());
    modelById = new Map(catalog.models.map((m) => [m.id, m]));
  } catch (e) {
    showLoadError(e);
    return;
  }
  // 基準が URL に無い / カタログに無いときは自動で選ぶ
  const pre = filterModels(catalog, { providers: MAJOR_PROVIDERS, scope: 'main', ageMonths: 0, query: '', maxCount: 0 });
  if (!state.metric) state.metric = defaultMetric(pre);
  if (!state.base || !catalog.models.some((m) => m.id === state.base)) state.base = defaultBase(pre, state.metric)?.id ?? null;
  state.detail = null;
  resolveKeyMetrics();
  renderMeta();
  renderProviders();
  renderFooter();
  syncInputs();
  recompute();
}

/**
 * キャッシュバスター: GitHub Pages は index.html を最大 10 分キャッシュさせるため、
 * 古い index.html（= 古い JS）が出ることがある。最新のビルド ID を no-store で確かめ、
 * 違えば URL に ?_v= を付けて 1 回だけ読み直す（別 URL なのでキャッシュを通らない）。
 */
async function ensureLatestBuild(): Promise<boolean> {
  try {
    const res = await fetch(new URL('version.json', document.baseURI), { cache: 'no-store' });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: string };
    if (!build || build === __BUILD_ID__) return false;
    const key = `reloaded:${build}`;
    try {
      if (sessionStorage.getItem(key)) return false; // 読み直しても古いままなら諦めて今の版で動く
      sessionStorage.setItem(key, '1');
    } catch {
      return false;
    }
    const u = new URL(location.href);
    u.searchParams.set('_v', build);
    location.replace(u.toString());
    return true;
  } catch {
    return false;
  }
}

// URL を読む前の状態 = 初期表示。「初期状態に戻す」で使う
const DEFAULT_STATE: State = JSON.parse(JSON.stringify(state));

/** 表示の設定（メーカー・指標・トークン数・表示モードなど）を初期状態に戻す。データ（実データ/サンプル）はそのまま */
function resetView() {
  if (!catalog) return;
  const data = state.data;
  Object.assign(state, JSON.parse(JSON.stringify(DEFAULT_STATE)), { data });
  const pre = filterModels(catalog, { providers: MAJOR_PROVIDERS, scope: 'main', ageMonths: 0, query: '', maxCount: 0 });
  state.metric = defaultMetric(pre);
  state.base = defaultBase(pre, state.metric)?.id ?? null;
  customTok = false;
  renderProviders();
  syncInputs();
  withBusy('初期状態に戻しています…', recompute);
}

readUrl();
ensureLatestBuild().then((reloading) => {
  if (reloading) return;
  bindControls();
  start();
});
