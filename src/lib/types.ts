export interface MetricRecord {
  source: string;
  metric: string;
  score: number;
  evaluatedAt: string | null;
  version: string | null;
  config: string | null;
}

export interface Model {
  id: string;
  canonicalSlug: string | null;
  name: string;
  provider: string;
  providerSlug: string;
  createdAt: string | null;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  contextLength: number | null;
  supportedParameters: string[];
  inputModalities: string[];
  outputModalities: string[];
  hiddenReasons: string[];
  throughputTps: number | null;
  latencySeconds: number | null;
  speedMeasuredAt: string | null;
  metrics: MetricRecord[];
}

export interface BenchmarkMeta {
  source: string;
  asOf: string | null;
  version: string | null;
  citation: string | null;
  sourceUrl: string | null;
}

export interface Catalog {
  schemaVersion: number;
  isSample: boolean;
  fetchedAt: string;
  priceCurrency: string;
  priceUnit: string;
  sources: {
    models: { url: string; fetchedAt: string | null };
    benchmarks: { status: string; error?: string; fetchedAt?: string | null; metas: BenchmarkMeta[] };
  };
  stats: {
    modelCount: number;
    skippedModelRecords: number;
    benchmarkRecords: number;
    benchmarkMatched: number;
    benchmarkUnmatchedSlugs: string[];
  };
  models: Model[];
}

/** 指標キー = 出典 + 指標名 + 版。版や出典が違う値を同じ軸に並べないため */
export type MetricKey = string;

export interface Row {
  model: Model;
  cost: number | null;
  score: number | null;
  metric: MetricRecord | null;
  relScore: number | null;
  relCost: number | null;
  relEfficiency: number | null;
  relSpeed: number | null;
  relLatency: number | null;
  scorePerDollar: number | null;
  pareto: boolean;
}
