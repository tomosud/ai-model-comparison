// OpenRouter の生データを catalog.json の形に正規化する純粋関数群。
// ネットワークにもファイルにも触らないので単体テストできる。

export const SCHEMA_VERSION = 1;

/** 文字列/数値を有限数に。取れなければ null（0 とは区別する） */
export function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** USD/トークン → USD/100万トークン。負値・不正値は null */
export function perTokenToPerMillion(v) {
  const n = toNum(v);
  if (n === null || n < 0) return null;
  // 浮動小数の誤差 (0.000002*1e6=1.9999999) を丸める
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  'x-ai': 'xAI',
  qwen: 'Qwen',
};

export function providerOf(id) {
  const slug = String(id).split('/')[0];
  return { providerSlug: slug, provider: PROVIDER_LABELS[slug] ?? slug };
}

/** 既定で隠す種類の判定。理由の配列を返す（空なら主要表示の候補） */
export function hiddenReasons(raw) {
  const id = String(raw.id ?? '');
  const reasons = [];
  if (id.includes(':')) reasons.push(`variant:${id.split(':').pop()}`); // :free :batch :thinking など
  const out = raw.architecture?.output_modalities;
  if (Array.isArray(out) && !(out.length === 1 && out[0] === 'text')) reasons.push('non-text-output');
  if (/embed/i.test(id)) reasons.push('embedding');
  if (/(^|[-/])(preview|exp|experimental|alpha|beta)([-.]|$)/i.test(id)) reasons.push('experimental');
  if (/-\d{4}-?\d{2}-?\d{2}$|-\d{4}$/.test(id.split('/')[1] ?? '')) reasons.push('dated-snapshot');
  if (raw.expiration_date) reasons.push('expiring');
  return reasons;
}

/** Models API の 1 件を正規化。id が無いものは null（捨てる） */
export function normalizeModel(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.includes('/')) return null;
  const { provider, providerSlug } = providerOf(raw.id);
  const created = toNum(raw.created);
  const arch = raw.architecture ?? {};
  return {
    id: raw.id,
    canonicalSlug: typeof raw.canonical_slug === 'string' ? raw.canonical_slug : null,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    provider,
    providerSlug,
    createdAt: created !== null ? new Date(created * 1000).toISOString() : null,
    inputUsdPerMillion: perTokenToPerMillion(raw.pricing?.prompt),
    outputUsdPerMillion: perTokenToPerMillion(raw.pricing?.completion),
    contextLength: toNum(raw.context_length),
    supportedParameters: Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [],
    inputModalities: Array.isArray(arch.input_modalities) ? arch.input_modalities : [],
    outputModalities: Array.isArray(arch.output_modalities) ? arch.output_modalities : [],
    hiddenReasons: hiddenReasons(raw),
    throughputTps: null,
    latencySeconds: null,
    speedMeasuredAt: null,
    metrics: [],
  };
}

const AA_INDEXES = [
  'intelligence_index',
  'coding_index',
  'agentic_index',
  'finance_and_accounting_index',
  'strategy_and_ops_index',
  'legal_index',
  'healthcare_and_medical_index',
  'engineering_index',
  'economics_index',
  'cyber_index',
  'openness_index',
  'multilingual_index',
  'decision_index',
];

/**
 * Benchmarks API の 1 レスポンス（{data, meta}）を指標レコードの配列にする。
 * 1 レコード = モデル × 出典 × 指標。値を合成しない。
 */
export function normalizeBenchmarkResponse(resp) {
  const out = [];
  const meta = resp?.meta ?? {};
  const asOf = typeof meta.as_of === 'string' ? meta.as_of : null;
  const version = typeof meta.version === 'string' ? meta.version : null;
  for (const item of Array.isArray(resp?.data) ? resp.data : []) {
    const slug = item?.model_permaslug;
    if (typeof slug !== 'string') continue;
    if (item.source === 'artificial-analysis') {
      for (const key of AA_INDEXES) {
        const score = toNum(item[key]);
        if (score === null) continue;
        out.push({ modelPermaslug: slug, source: 'artificial-analysis', metric: key, score, evaluatedAt: asOf, version, config: null });
      }
    } else if (item.source === 'openrouter' && typeof item.benchmark_type === 'string') {
      const score = toNum(item.accuracy);
      if (score === null) continue;
      out.push({
        modelPermaslug: slug,
        source: 'openrouter',
        metric: `${item.benchmark_type}_accuracy`,
        score,
        evaluatedAt: typeof item.last_run_timestamp === 'string' ? item.last_run_timestamp : asOf,
        version,
        config: null,
      });
    } else if (item.source === 'design-arena' && typeof item.category === 'string' && (item.arena ?? 'models') === 'models') {
      // 人の投票による対戦。Elo（差で見る）と勝率（%）を別の指標として持つ
      const cat = item.category.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      for (const [suffix, v] of [['elo', item.elo], ['win_rate', item.win_rate]]) {
        const score = toNum(v);
        if (score === null) continue;
        out.push({ modelPermaslug: slug, source: 'design-arena', metric: `design_arena_${cat}_${suffix}`, score, evaluatedAt: asOf, version, config: null });
      }
    }
    // search の形は評価条件が多様なため初版では取り込まない
  }
  return out;
}

/**
 * model_permaslug を canonical_slug（無ければ id）で照合。表示名では照合しない。
 * `openai/x` と `openai/x:batch` のように同じ canonical_slug を共有するモデルは
 * 中身が同じモデル（課金形態だけ違う）なので、全員に同じスコアを付ける。
 */
export function attachMetrics(models, records) {
  const bySlug = new Map();
  const byId = new Map();
  for (const m of models) {
    if (m.canonicalSlug) {
      const list = bySlug.get(m.canonicalSlug) ?? [];
      list.push(m);
      bySlug.set(m.canonicalSlug, list);
    }
    byId.set(m.id, m);
  }
  const unmatched = new Set();
  let matched = 0;
  for (const r of records) {
    const targets = bySlug.get(r.modelPermaslug) ?? (byId.has(r.modelPermaslug) ? [byId.get(r.modelPermaslug)] : []);
    if (!targets.length) {
      unmatched.add(r.modelPermaslug);
      continue;
    }
    const { modelPermaslug, ...rest } = r;
    let used = false;
    for (const m of targets) {
      // 同じ出典・指標・版が重複したら先勝ち（合成しない）
      if (m.metrics.some((x) => x.source === r.source && x.metric === r.metric && x.version === r.version)) continue;
      m.metrics.push({ ...rest });
      used = true;
    }
    if (used) matched++;
  }
  return { matched, unmatched: [...unmatched].sort() };
}

/** 複数エンドポイントの p50 の中央値。値が無ければ null */
export function medianP50(endpoints, field) {
  const vals = [];
  for (const e of Array.isArray(endpoints) ? endpoints : []) {
    const v = e?.[field];
    const n = toNum(v && typeof v === 'object' ? v.p50 : v);
    if (n !== null && n > 0) vals.push(n);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** 生データ一式から catalog を作る。生データが壊れていても落ちない */
export function buildCatalog({ modelsResp, benchmarkRecords, benchmarkStatus, speeds, fetchedAt }) {
  const raw = Array.isArray(modelsResp?.data) ? modelsResp.data : [];
  const models = raw.map(normalizeModel).filter(Boolean);
  const join = attachMetrics(models, benchmarkRecords ?? []);
  for (const m of models) {
    const s = speeds?.[m.id];
    if (s) {
      m.throughputTps = s.throughputTps ?? null;
      m.latencySeconds = s.latencySeconds ?? null;
      m.speedMeasuredAt = s.measuredAt ?? null;
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    isSample: false,
    fetchedAt,
    priceCurrency: 'USD',
    priceUnit: 'per_million_tokens',
    sources: {
      models: { url: 'https://openrouter.ai/api/v1/models', license: 'OpenRouter', fetchedAt },
      benchmarks: benchmarkStatus,
    },
    stats: {
      modelCount: models.length,
      skippedModelRecords: raw.length - models.length,
      benchmarkRecords: (benchmarkRecords ?? []).length,
      benchmarkMatched: join.matched,
      benchmarkUnmatchedSlugs: join.unmatched,
    },
    models,
  };
}
