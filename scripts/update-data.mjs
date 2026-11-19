// OpenRouter からモデル・ベンチマーク・速度を取得し public/data/catalog.json を書く。
// GitHub Actions で 1 日 1 回動かす想定。APIキーは環境変数 OPENROUTER_API_KEY からだけ読み、
// どこにも書き出さない。取得に失敗したら前回の正常なファイルを残す（空で上書きしない）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, buildUsage, normalizeBenchmarkResponse, medianP50, normalizeModel } from './normalize.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(ROOT, 'public/data');
const CATALOG = resolve(DATA_DIR, 'catalog.json');
const BENCH_CACHE = resolve(DATA_DIR, 'benchmarks.json');
const RANK_CACHE = resolve(DATA_DIR, 'rankings.json');
const API = 'https://openrouter.ai/api/v1';
const KEY = process.env.OPENROUTER_API_KEY?.trim() || null;
const SPEED_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'deepseek', 'meta-llama', 'mistralai', 'x-ai', 'qwen']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { auth = false, tries = 5 } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'ai-model-comparison-dashboard' };
  if (auth && KEY) headers.Authorization = `Bearer ${KEY}`;
  let wait = 2000;
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(wait);
      wait *= 2;
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || i >= tries) throw new Error(`${res.status} ${res.statusText} @ ${url.replace(API, '')}`);
    const ra = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait);
    wait *= 2;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchBenchmarks() {
  if (!KEY) return { records: null, status: 'no_key', error: 'OPENROUTER_API_KEY が未設定' };
  const records = [];
  const metas = [];
  try {
    for (const source of ['artificial-analysis', 'openrouter']) {
      const resp = await getJson(`${API}/benchmarks?source=${source}`, { auth: true });
      records.push(...normalizeBenchmarkResponse(resp));
      metas.push({ source, asOf: resp?.meta?.as_of ?? null, version: resp?.meta?.version ?? null, citation: resp?.meta?.citation ?? null, sourceUrl: resp?.meta?.source_url ?? null });
      await sleep(2500); // 30 req/min を守る
    }
  } catch (e) {
    return { records: null, status: 'error', error: String(e.message ?? e) };
  }
  // Design Arena（コーディング部門）は無くても困らないので、失敗しても他は使う
  try {
    const resp = await getJson(`${API}/benchmarks?source=design-arena&arena=models&category=codecategories`, { auth: true, tries: 3 });
    const recs = normalizeBenchmarkResponse(resp);
    records.push(...recs);
    metas.push({ source: 'design-arena', asOf: resp?.meta?.as_of ?? null, version: resp?.meta?.version ?? null, citation: resp?.meta?.citation ?? null, sourceUrl: resp?.meta?.source_url ?? null });
    console.log(`design-arena: ${recs.length} records`);
  } catch (e) {
    console.warn(`design-arena skip: ${e.message}`);
  }
  return { records, status: 'ok', metas };
}

/** 利用量ランキング（日次の直近 5 週 + プログラミング用途の週次）。失敗したら null */
async function fetchRankings() {
  if (!KEY) return { status: 'no_key', error: 'OPENROUTER_API_KEY が未設定' };
  const ymd = (d) => d.toISOString().slice(0, 10);
  const ago = (k) => ymd(new Date(Date.now() - k * 86_400_000));
  try {
    const daily = await getJson(`${API}/datasets/rankings-daily?period=day&start_date=${ago(35)}`, { auth: true, tries: 3 });
    await sleep(2500);
    let code = null;
    try {
      code = await getJson(`${API}/datasets/rankings-daily?period=week&category=programming&start_date=${ago(35)}`, { auth: true, tries: 3 });
    } catch (e) {
      console.warn(`rankings programming skip: ${e.message}`);
    }
    if (!Array.isArray(daily?.data) || !daily.data.length) throw new Error('rankings-daily が空です');
    return { status: 'ok', daily, code };
  } catch (e) {
    return { status: 'error', error: String(e.message ?? e) };
  }
}

/** 主要メーカーのテキストモデルだけ、エンドポイントの速度・遅延を取る（キーがある時のみ） */
async function fetchSpeeds(modelsResp) {
  if (!KEY) return {};
  const targets = (modelsResp.data ?? [])
    .map(normalizeModel)
    .filter((m) => m && SPEED_PROVIDERS.has(m.providerSlug) && m.hiddenReasons.length === 0)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 120);
  const out = {};
  for (const m of targets) {
    try {
      const resp = await getJson(`${API}/models/${m.id}/endpoints`, { auth: true, tries: 3 });
      const eps = resp?.data?.endpoints;
      const t = medianP50(eps, 'throughput_last_30m');
      // latency_last_30m はミリ秒で返る（実測で 1,000〜14,000 程度）。秒にそろえる
      const lMs = medianP50(eps, 'latency_last_30m');
      const l = lMs === null ? null : Math.round(lMs) / 1000;
      if (t !== null || l !== null) out[m.id] = { throughputTps: t, latencySeconds: l, measuredAt: new Date().toISOString() };
    } catch (e) {
      console.warn(`speed skip ${m.id}: ${e.message}`);
    }
    await sleep(2100);
  }
  return out;
}

async function main() {
  const fetchedAt = new Date().toISOString();
  let modelsResp;
  try {
    modelsResp = await getJson(`${API}/models`);
  } catch (e) {
    console.error(`モデル一覧の取得に失敗。前回の catalog.json を残します: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(modelsResp?.data) || modelsResp.data.length < 10) {
    console.error('モデル一覧が想定外の形か少なすぎるため、前回の catalog.json を残します');
    process.exitCode = 1;
    return;
  }

  const bench = await fetchBenchmarks();
  let records = bench.records;
  let benchmarkStatus;
  if (records) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(BENCH_CACHE, JSON.stringify({ fetchedAt, metas: bench.metas, records }, null, 1));
    benchmarkStatus = { status: 'ok', fetchedAt, metas: bench.metas };
  } else {
    const prev = await readJson(BENCH_CACHE);
    records = prev?.records ?? [];
    benchmarkStatus = {
      status: prev ? 'stale' : bench.status,
      error: bench.error,
      fetchedAt: prev?.fetchedAt ?? null,
      metas: prev?.metas ?? [],
    };
    console.warn(`ベンチマーク: ${bench.error}。${prev ? `前回 (${prev.fetchedAt}) の値を使います` : 'スコアなしで出力します'}`);
  }

  let speeds = await fetchSpeeds(modelsResp);
  if (!Object.keys(speeds).length) {
    // 取れなかったら前回の速度を引き継ぐ
    const prev = await readJson(CATALOG);
    speeds = {};
    for (const m of prev?.models ?? []) {
      if (m.throughputTps !== null || m.latencySeconds !== null) speeds[m.id] = { throughputTps: m.throughputTps, latencySeconds: m.latencySeconds, measuredAt: m.speedMeasuredAt };
    }
  }

  const rk = await fetchRankings();
  let rankRaw = null;
  let rankingsStatus;
  if (rk.status === 'ok') {
    rankRaw = { fetchedAt, daily: rk.daily, code: rk.code };
    await writeFile(RANK_CACHE, JSON.stringify(rankRaw));
    rankingsStatus = { status: 'ok', fetchedAt, asOf: rk.daily?.meta?.as_of ?? null, codeAsOf: rk.code?.meta?.as_of ?? null };
  } else {
    rankRaw = await readJson(RANK_CACHE);
    rankingsStatus = { status: rankRaw ? 'stale' : rk.status, error: rk.error, fetchedAt: rankRaw?.fetchedAt ?? null, asOf: rankRaw?.daily?.meta?.as_of ?? null, codeAsOf: rankRaw?.code?.meta?.as_of ?? null };
    console.warn(`ランキング: ${rk.error}。${rankRaw ? `前回 (${rankRaw.fetchedAt}) の値を使います` : '利用量なしで出力します'}`);
  }
  const usage = rankRaw ? buildUsage(rankRaw.daily, rankRaw.code) : null;

  const catalog = buildCatalog({ modelsResp, benchmarkRecords: records, benchmarkStatus, speeds, fetchedAt, usage, rankingsStatus });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CATALOG, JSON.stringify(catalog));
  const s = catalog.stats;
  console.log(`catalog.json: models=${s.modelCount} benchmarkRecords=${s.benchmarkRecords} matched=${s.benchmarkMatched} unmatchedSlugs=${s.benchmarkUnmatchedSlugs.length} speeds=${Object.keys(speeds).length} usage=${catalog.sources.rankings.matched}`);
  if (s.benchmarkUnmatchedSlugs.length) console.log(`未一致 slug (先頭20): ${s.benchmarkUnmatchedSlugs.slice(0, 20).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
