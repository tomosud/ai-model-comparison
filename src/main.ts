import './style.css';
import * as echarts from 'echarts/core';
import { ScatterChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
import { buildRows, fmtNum, fmtRatio, fmtUsd, parseMetricKey, scenarioCostUsd, findMetric } from './lib/calc';
import { availableMetrics, defaultBase, defaultMetric, EXTRA_PROVIDERS, filterModels, MAJOR_PROVIDERS } from './lib/select';
import type { Catalog, MetricKey, Model, Row } from './lib/types';

echarts.use([ScatterChart, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, LabelLayout, CanvasRenderer]);

// ---------- 状態 ----------
type SortKey = 'provider' | 'name' | 'score' | 'relScore' | 'cost' | 'relCost' | 'relEfficiency' | 'speed' | 'relSpeed' | 'latency' | 'relLatency' | 'created';
interface State {
  data: 'live' | 'sample';
  providers: string[];
  metric: MetricKey | null;
  inTok: number;
  outTok: number;
  ageMonths: number;
  scope: 'main' | 'all';
  maxCount: number;
  query: string;
  mode: 'abs' | 'rel';
  logX: boolean;
  pareto: boolean;
  labels: 'all' | 'pareto' | 'none';
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
  query: '',
  mode: 'abs',
  logX: false,
  pareto: true,
  labels: 'all',
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
};
/** 縦軸の指標が何を測るか（高いほど良い） */
const METRIC_HELP: Record<string, string> = {
  intelligence_index: '総合力。Artificial Analysis が複数の評価（推論・知識・数学・コーディングなど）をまとめた指数',
  engineering_index: 'ソフトウェア・技術系の実務タスク。今のデータで「コーディング寄り」に一番近い指標',
  coding_index: 'コーディング指数。Artificial Analysis が更新をやめた旧指標で、古いモデルにしか値が無い',
  agentic_index: 'エージェント（ツールを使う多段タスク）指数。更新が止まった旧指標で、古いモデルにしか値が無い',
  gpqa_diamond_accuracy: '大学院レベルの理科の難問（GPQA Diamond）の正答率。OpenRouter が自前で計測',
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

const SOURCE_LABELS: Record<string, string> = { 'artificial-analysis': 'Artificial Analysis', openrouter: 'OpenRouter', sample: 'サンプル' };

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
  if (q.get('scope') === 'all') state.scope = 'all';
  if (q.get('mode') === 'rel') state.mode = 'rel';
  if (q.get('log') === '1') state.logX = true;
  if (q.get('pareto') === '0') state.pareto = false;
  const lbl = q.get('lbl');
  if (lbl === 'pareto' || lbl === 'none') state.labels = lbl;
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
  if (state.scope === 'all') q.set('scope', 'all');
  q.set('mode', state.mode);
  if (state.logX) q.set('log', '1');
  if (!state.pareto) q.set('pareto', '0');
  if (state.labels !== 'all') q.set('lbl', state.labels);
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
  visible = filterModels(catalog, { providers: state.providers, scope: state.scope, ageMonths: state.ageMonths, query: state.query, maxCount: state.maxCount });
  const metrics = availableMetrics(visible);
  // 選んでいた指標が表示対象に無いときだけ差し替える（表示対象に指標が 1 つも無ければ保持）
  if (metrics.length && !metrics.some((m) => m.key === state.metric)) state.metric = defaultMetric(visible);
  // 基準はフィルタの影響を受けない（カタログ全体から引く）
  const base = baseModel();
  rows = buildRows(visible, base, state.metric, state.inTok, state.outTok);
  renderMetricSelect(metrics);
  renderBanners();
  renderChart();
  renderBaseCard();
  renderDetail();
  renderTable();
  writeUrl();
}

function baseModel(): Model | null {
  return catalog?.models.find((m) => m.id === state.base) ?? null;
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
  const point = (r: Row) => ({ id: r.model.id, value: [x(r), y(r)], name: shortName(r.model), row: r });
  const series: Record<string, unknown>[] = [];
  for (const [slug, list] of groups) {
    series.push({
      type: 'scatter',
      name: providerName(slug),
      data: list.map(point),
      symbolSize: 11,
      itemStyle: { color: providerColor(slug), borderColor: surface, borderWidth: 1 },
      emphasis: { focus: 'self', label: { show: true }, itemStyle: { borderColor: text, borderWidth: 2 } },
      label: {
        show: true,
        position: 'right',
        color: muted,
        fontSize: 11,
        formatter: (p: { data: { row: Row; name: string } }) => (state.labels === 'all' || (state.labels === 'pareto' && p.data.row.pareto) ? p.data.name : ''),
      },
      labelLayout: { hideOverlap: true },
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
    series.push({
      type: 'scatter',
      name: '基準',
      data: [point(baseRow)],
      symbol: 'path://M50,3 L61,38 L98,38 L68,60 L79,95 L50,73 L21,95 L32,60 L2,38 L39,38 Z',
      symbolSize: 26,
      z: 10,
      itemStyle: { color: providerColor(baseRow.model.providerSlug), borderColor: text, borderWidth: 2 },
      label: { show: true, position: 'top', color: text, fontWeight: 'bold', fontSize: 12, formatter: (p: { data: { name: string } }) => `基準: ${p.data.name}` },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: muted, type: 'dashed', width: 1 },
        data: markLines,
      },
    });
  }

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
      legend: { top: 0, textStyle: { color: text }, data: [...groups.keys()].map(providerName).concat(baseRow ? ['基準'] : []) },
      grid: { left: 64, right: 28, top: 40, bottom: 76, containLabel: true },
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
        axisLabel: { color: muted, formatter: (v: number) => (rel ? `${+v.toFixed(2)}×` : `$${+v.toPrecision(3)}`) },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, opacity: 0.6 } },
        scale: true,
      },
      yAxis: {
        type: 'value',
        name: yName,
        nameLocation: 'middle',
        nameGap: 52,
        nameTextStyle: { color: muted },
        axisLabel: { color: muted, formatter: (v: number) => (rel ? `${+v.toFixed(2)}×` : `${+v.toPrecision(4)}`) },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, opacity: 0.6 } },
        scale: true,
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false },
        { type: 'inside', yAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false },
        { type: 'slider', xAxisIndex: 0, height: 16, bottom: 6, filterMode: 'none', textStyle: { color: muted }, borderColor: border },
      ],
      series,
    },
    { notMerge: true },
  );
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
    el.innerHTML = `<div class="label-small">基準モデル</div><p>未選択です。散布図の点か、表のモデル名をクリックして選んでください。</p>`;
    return;
  }
  const cost = scenarioCostUsd(base, state.inTok, state.outTok);
  const metric = findMetric(base, state.metric);
  const outside = !visible.some((m) => m.id === base.id);
  el.innerHTML = `<div class="label-small">基準モデル（= 1.00×）</div>
    <div class="model-title"><span class="dot" style="background:${providerColor(base.providerSlug)}"></span><h3>${esc(shortName(base))}</h3></div>
    <div class="model-id">${esc(base.id)}</div>
    <dl class="kv">
      <dt>入力単価</dt><dd>$${fmtNum(base.inputUsdPerMillion, 3)} / 100万tok</dd>
      <dt>出力単価</dt><dd>$${fmtNum(base.outputUsdPerMillion, 3)} / 100万tok</dd>
      <dt>想定コスト</dt><dd>${fmtUsd(cost)}</dd>
      <dt>スコア</dt><dd>${metric ? fmtNum(metric.score, 2) : 'N/A（未評価）'}</dd>
      <dt>速度</dt><dd>${base.throughputTps !== null ? `${fmtNum(base.throughputTps, 0)} tok/s` : '未取得'}</dd>
    </dl>
    ${outside ? '<div class="warn-inline">基準モデルは現在のフィルタ外です（設定は保持しています）。</div>' : ''}`;
}

function bar(label: string, v: number | null, better: 'high' | 'low') {
  const max = 3;
  const w = v === null ? 0 : Math.min(v, max) / max;
  const cls = v === null || Math.abs(v - 1) < 0.005 ? 'na' : (v > 1) === (better === 'high') ? 'good' : 'bad';
  return `<div class="bar-row"><span>${label}<br><span class="na" style="font-size:10.5px">${better === 'high' ? '高いほど良い' : '低いほど良い'}</span></span>
    <div class="bar-track"><div class="bar-fill" style="width:${(w * 100).toFixed(1)}%;${v === null ? '' : `background:var(--${cls === 'na' ? 'neutral' : cls})`}"></div><div class="bar-one" style="left:${(100 / max).toFixed(2)}%"></div></div>
    <span class="bar-val ${cls}">${fmtRatio(v)}</span></div>`;
}

function renderDetail() {
  const el = $('detail');
  const id = state.detail ?? state.base;
  const m = catalog?.models.find((x) => x.id === id);
  if (!m) {
    el.innerHTML = `<div class="label-small">モデル詳細</div><p class="na">表の行をクリックすると、ここに詳細が出ます。</p>`;
    return;
  }
  const r = rows.find((x) => x.model.id === m.id) ?? buildRows([m], baseModel(), state.metric, state.inTok, state.outTok)[0];
  const metrics = [...m.metrics].sort((a, b) => a.metric.localeCompare(b.metric));
  el.innerHTML = `<div class="label-small">モデル詳細</div>
    <div class="model-title"><span class="dot" style="background:${providerColor(m.providerSlug)}"></span><h3>${esc(shortName(m))}</h3></div>
    <div class="model-id">${esc(m.id)}</div>
    <dl class="kv">
      <dt>メーカー</dt><dd>${esc(providerName(m.providerSlug))}</dd>
      <dt>登録日</dt><dd>${esc(fmtDay(m.createdAt))}</dd>
      <dt>入力 / 出力</dt><dd>$${fmtNum(m.inputUsdPerMillion, 3)} / $${fmtNum(m.outputUsdPerMillion, 3)}</dd>
      <dt>想定コスト</dt><dd>${fmtUsd(r.cost)}</dd>
      <dt>コンテキスト</dt><dd>${m.contextLength !== null ? m.contextLength.toLocaleString() : 'N/A'}</dd>
      <dt>速度 / 遅延</dt><dd>${m.throughputTps !== null ? `${fmtNum(m.throughputTps, 0)} tok/s` : '未取得'} / ${m.latencySeconds !== null ? `${fmtNum(m.latencySeconds, 2)} s` : '未取得'}</dd>
      ${m.hiddenReasons.length ? `<dt>既定で非表示</dt><dd>${esc(m.hiddenReasons.join(', '))}</dd>` : ''}
    </dl>
    <div class="bars" aria-label="基準比（縦線 = 1.00×）">
      ${bar('スコア', r.relScore, 'high')}
      ${bar('コスト', r.relCost, 'low')}
      ${bar('効率', r.relEfficiency, 'high')}
      ${bar('速度', r.relSpeed, 'high')}
      ${bar('遅延', r.relLatency, 'low')}
    </div>
    <div class="label-small" style="margin-top:10px">評価スコア（${metrics.length}）</div>
    ${metrics.length ? `<ul class="metric-list">${metrics.map((x) => `<li><span>${esc(METRIC_LABELS[x.metric] ?? x.metric)}<br><span class="src">${esc(SOURCE_LABELS[x.source] ?? x.source)}${x.version ? ` ${esc(x.version)}` : ''} ・ ${esc(fmtDay(x.evaluatedAt))}</span></span><b>${fmtNum(x.score, 2)}</b></li>`).join('')}</ul>` : '<p class="na">未評価</p>'}
    ${m.id !== state.base ? `<button class="btn" id="detailSetBase" style="margin-top:10px">このモデルを基準にする</button>` : ''}`;
  $('detailSetBase')?.addEventListener('click', () => setBase(m.id));
}

const COLUMNS: { key: SortKey; label: string; cls?: string; title?: string }[] = [
  { key: 'provider', label: 'メーカー', cls: 'l' },
  { key: 'name', label: 'モデル', cls: 'l col-model' },
  { key: 'score', label: 'スコア' },
  { key: 'relScore', label: 'スコア比', title: '高いほど良い（数値の比であり知能の倍率ではない）' },
  { key: 'cost', label: '想定コスト' },
  { key: 'relCost', label: 'コスト比', title: '低いほど安い' },
  { key: 'relEfficiency', label: 'コスト効率比', title: '高いほど効率的' },
  { key: 'speed', label: '速度' },
  { key: 'relSpeed', label: '速度比', title: '高いほど速い' },
  { key: 'latency', label: '遅延' },
  { key: 'relLatency', label: '遅延比', title: '低いほど良い' },
  { key: 'created', label: '登録日' },
];

function sortValue(r: Row, k: SortKey): number | string | null {
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
    case 'created': return r.model.createdAt;
  }
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
  const head = `<thead><tr>${COLUMNS.map((c) => `<th class="${c.cls ?? ''}" data-key="${c.key}" ${c.title ? `title="${esc(c.title)}"` : ''} aria-sort="${state.sortKey === c.key ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none'}" tabindex="0">${c.label}</th>`).join('')}</tr></thead>`;
  const body = list
    .map((r) => {
      const m = r.model;
      const isBase = base?.id === m.id;
      const src = r.metric ? `${SOURCE_LABELS[r.metric.source] ?? r.metric.source} ・ ${fmtDay(r.metric.evaluatedAt)}` : '未評価';
      return `<tr data-id="${esc(m.id)}" class="${isBase ? 'is-base' : ''} ${state.detail === m.id ? 'is-detail' : ''}">
        <td class="l"><span class="prov"><span class="dot" style="background:${providerColor(m.providerSlug)}"></span>${esc(providerName(m.providerSlug))}</span></td>
        <td class="l col-model" title="${esc(m.id)}"><button type="button" class="model-btn" data-base="${esc(m.id)}" title="クリックで基準に設定">${esc(shortName(m))}</button>${isBase ? '<span class="tag base">基準</span>' : ''}${r.pareto ? '<span class="tag pareto">パレート</span>' : ''}</td>
        <td title="${esc(src)}">${r.score === null ? '<span class="na">未評価</span>' : fmtNum(r.score, 2)}</td>
        ${ratioCell(r.relScore, 'high', `${fmtNum(r.score, 4)} ÷ ${fmtNum(base ? findMetric(base, state.metric)?.score ?? null : null, 4)}`)}
        <td title="入力 $${fmtNum(m.inputUsdPerMillion, 4)} / 出力 $${fmtNum(m.outputUsdPerMillion, 4)} per 100万tok">${fmtUsd(r.cost)}</td>
        ${ratioCell(r.relCost, 'low', `${fmtUsd(r.cost)} ÷ ${fmtUsd(base ? scenarioCostUsd(base, state.inTok, state.outTok) : null)}`)}
        ${ratioCell(r.relEfficiency, 'high', r.scorePerDollar === null ? 'スコア/ドルが定義できません' : `スコア/ドル = ${r.scorePerDollar.toFixed(3)}`)}
        <td>${m.throughputTps !== null ? `${fmtNum(m.throughputTps, 0)} tok/s` : '<span class="na">未取得</span>'}</td>
        ${ratioCell(r.relSpeed, 'high', `${fmtNum(m.throughputTps, 1)} tok/s`)}
        <td>${m.latencySeconds !== null ? `${fmtNum(m.latencySeconds, 2)} s` : '<span class="na">未取得</span>'}</td>
        ${ratioCell(r.relLatency, 'low', `${fmtNum(m.latencySeconds, 3)} s`)}
        <td>${esc(fmtDay(m.createdAt))}</td>
      </tr>`;
    })
    .join('');
  $('table').innerHTML = head + `<tbody>${body || `<tr><td colspan="${COLUMNS.length}" class="l na">条件に合うモデルがありません。</td></tr>`}</tbody>`;
}

function renderFooter() {
  if (!catalog) return;
  const b = catalog.sources.benchmarks;
  const aa = b.metas?.find((m) => m.source === 'artificial-analysis');
  $('footer').innerHTML = `
    <h3>出典とライセンス</h3>
    <p>モデル・価格: <a href="https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties" target="_blank" rel="noopener">OpenRouter Models API</a>（${esc(fmtDate(catalog.fetchedAt))} 取得）。価格は OpenRouter 経由の表示価格で、開発元と直接契約したときの価格とは異なる場合があります。</p>
    <p>ベンチマーク: <a href="https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks" target="_blank" rel="noopener">OpenRouter Benchmarks API</a>${aa ? `（Artificial Analysis 指標は <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">Artificial Analysis</a> による。as of ${esc(fmtDate(aa.asOf))}${aa.citation ? ` ・ ${esc(aa.citation)}` : ''}）` : ''}。Source: OpenRouter Data API (openrouter.ai/docs/cookbook/administration/data-api), as of ${esc(b.fetchedAt ?? catalog.fetchedAt)}. Licensed under CC BY 4.0.</p>
    <p>照合: ベンチマーク ${catalog.stats.benchmarkRecords} 件中 ${catalog.stats.benchmarkMatched} 件をモデル ID で照合。未一致 ${catalog.stats.benchmarkUnmatchedSlugs.length} 種（表示名では照合しません）。</p>
    <h3>計算方法</h3>
    <p>想定コスト = 入力単価 × 入力トークン ÷ 100万 + 出力単価 × 出力トークン ÷ 100万。各比 = 対象の値 ÷ 基準の値。基準が 0 / 不明のときは N/A。パレート最適 = スコアが同等以上かつコストが同等以下で、どちらかが厳密に良い他モデルが存在しないもの。</p>
    <h3>限界</h3>
    <p>指標・出典・版が違うスコアは混ぜません。速度・遅延は OpenRouter エンドポイントの直近 30 分の中央値（取得できたもののみ）。「最新」はモデルの登録日であり、データの取得時刻とは別です。</p>`;
}

// ---------- 操作 ----------
function setBase(id: string) {
  state.base = id;
  state.detail = id;
  recompute();
}

async function switchData(d: 'live' | 'sample') {
  state.data = d;
  state.base = null;
  state.metric = null;
  await start();
}

function bindControls() {
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
  $<HTMLSelectElement>('age').addEventListener('change', (e) => { state.ageMonths = Number((e.target as HTMLSelectElement).value); recompute(); });
  $<HTMLSelectElement>('scope').addEventListener('change', (e) => { state.scope = (e.target as HTMLSelectElement).value as State['scope']; recompute(); });
  $<HTMLSelectElement>('max').addEventListener('change', (e) => { state.maxCount = Number((e.target as HTMLSelectElement).value); recompute(); });
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
    const tr = target.closest<HTMLElement>('tr[data-id]');
    if (tr?.dataset.id) {
      state.detail = tr.dataset.id;
      renderDetail();
      renderTable();
    }
  });
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
    clearTimeout(rt);
    rt = window.setTimeout(renderChart, 150); // 幅の境目をまたいだら軸名を描き直す
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderProviders(); recompute(); });
}

function syncInputs() {
  $<HTMLInputElement>('inTok').value = String(state.inTok);
  $<HTMLInputElement>('outTok').value = String(state.outTok);
  const setSel = (id: string, v: string) => {
    const s = $<HTMLSelectElement>(id);
    if (![...s.options].some((o) => o.value === v)) s.add(new Option(v === '0' ? 'すべて' : v, v));
    s.value = v;
  };
  setSel('age', String(state.ageMonths));
  setSel('max', String(state.maxCount));
  $<HTMLSelectElement>('scope').value = state.scope;
  $<HTMLInputElement>('query').value = state.query;
  $<HTMLInputElement>('logX').checked = state.logX;
  $<HTMLInputElement>('pareto').checked = state.pareto;
  $<HTMLSelectElement>('labels').value = state.labels;
}

function exportCsv() {
  const base = baseModel();
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? 'N/A' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v: number | null, d = 4) => (v === null ? null : +v.toFixed(d));
  const header = ['provider', 'model_id', 'model_name', 'metric', 'metric_source', 'evaluated_at', 'score', 'relative_score', 'input_usd_per_million', 'output_usd_per_million', 'scenario_cost_usd', 'relative_cost', 'relative_efficiency', 'throughput_tps', 'relative_speed', 'latency_s', 'relative_latency', 'is_base', 'pareto'];
  const lines = [
    `# base=${base?.id ?? 'none'} input_tokens=${state.inTok} output_tokens=${state.outTok} metric=${state.metric ?? 'none'} data_fetched_at=${catalog?.fetchedAt ?? ''}${catalog?.isSample ? ' SAMPLE_DATA' : ''}`,
    header.join(','),
    ...sortedRows().map((r) =>
      [providerName(r.model.providerSlug), r.model.id, shortName(r.model), r.metric?.metric, r.metric?.source, r.metric?.evaluatedAt, r.score, num(r.relScore), r.model.inputUsdPerMillion, r.model.outputUsdPerMillion, num(r.cost, 6), num(r.relCost), num(r.relEfficiency), r.model.throughputTps, num(r.relSpeed), r.model.latencySeconds, num(r.relLatency), base?.id === r.model.id, r.pareto]
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
  } catch (e) {
    showLoadError(e);
    return;
  }
  // 基準が URL に無い / カタログに無いときは自動で選ぶ
  const pre = filterModels(catalog, { providers: MAJOR_PROVIDERS, scope: 'main', ageMonths: 0, query: '', maxCount: 0 });
  if (!state.metric) state.metric = defaultMetric(pre);
  if (!state.base || !catalog.models.some((m) => m.id === state.base)) state.base = defaultBase(pre, state.metric)?.id ?? null;
  state.detail = null;
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

readUrl();
ensureLatestBuild().then((reloading) => {
  if (reloading) return;
  bindControls();
  start();
});
