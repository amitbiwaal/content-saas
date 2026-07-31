/**
 * Metrics — counters, gauges, histograms, timers.
 *
 * Abstractions only. No provider SDK: nothing here imports Prometheus,
 * OpenTelemetry, or any vendor client. `packages/observability` is the only
 * place instrumentation is configured, and an exporter binds to this registry
 * at the process edge (`14-operations/monitoring.md` §7).
 */

import { assertLabelsAllowed, labelKey, type MetricLabels } from './labels.js';

export const METRIC_KINDS = ['counter', 'gauge', 'histogram'] as const;

export type MetricKind = (typeof METRIC_KINDS)[number];

export function isMetricKind(value: unknown): value is MetricKind {
  return typeof value === 'string' && (METRIC_KINDS as readonly string[]).includes(value);
}

export interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly kind: MetricKind;
  /** Declared up front so an exporter knows the dimensions before any sample. */
  readonly labelNames: readonly string[];
  /** Histogram bucket upper bounds, in the metric's own unit. */
  readonly buckets?: readonly number[];
}

export interface Counter {
  inc(labels?: MetricLabels, by?: number): void;
}

export interface Gauge {
  set(value: number, labels?: MetricLabels): void;
  inc(labels?: MetricLabels, by?: number): void;
  dec(labels?: MetricLabels, by?: number): void;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
}

/**
 * A timer is a histogram plus a stopwatch. Durations are recorded in
 * **seconds**, matching the metric catalogue
 * (`http_request_duration_seconds`, `pipeline_stage_duration_seconds`).
 *
 * Duration naming: `...Seconds`, never bare `ttl`/`duration`
 * (`07-development-guide/coding-standards.md`).
 */
export interface Timer {
  /** Returns a function that records elapsed seconds when called. */
  start(labels?: MetricLabels): () => void;
  observeSeconds(seconds: number, labels?: MetricLabels): void;
}

export interface HistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  /** Cumulative counts, aligned with the definition's buckets, plus +Inf last. */
  readonly bucketCounts: readonly number[];
}

export interface MetricSample {
  readonly name: string;
  readonly kind: MetricKind;
  readonly labels: Readonly<Record<string, string>>;
  readonly value?: number;
  readonly histogram?: HistogramSnapshot;
}

/** Default buckets in seconds, covering sub-millisecond to ~1 minute. */
export const DEFAULT_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const;

interface Series {
  readonly labels: Readonly<Record<string, string>>;
  value: number;
  bucketCounts?: number[];
  sum?: number;
  count?: number;
}

class MetricInstrument {
  readonly definition: MetricDefinition;
  readonly #series = new Map<string, Series>();

  constructor(definition: MetricDefinition) {
    this.definition = definition;
  }

  #resolve(labels: Readonly<Record<string, string>>): Series {
    assertLabelsAllowed(labels);
    const key = labelKey(labels);
    let series = this.#series.get(key);
    if (series === undefined) {
      series = { labels: { ...labels }, value: 0 };
      if (this.definition.kind === 'histogram') {
        const buckets = this.definition.buckets ?? DEFAULT_DURATION_BUCKETS_SECONDS;
        series.bucketCounts = new Array<number>(buckets.length + 1).fill(0);
        series.sum = 0;
        series.count = 0;
      }
      this.#series.set(key, series);
    }
    return series;
  }

  add(labels: Readonly<Record<string, string>>, by: number): void {
    this.#resolve(labels).value += by;
  }

  set(labels: Readonly<Record<string, string>>, value: number): void {
    this.#resolve(labels).value = value;
  }

  observe(labels: Readonly<Record<string, string>>, value: number): void {
    const series = this.#resolve(labels);
    const buckets = this.definition.buckets ?? DEFAULT_DURATION_BUCKETS_SECONDS;
    series.sum = (series.sum ?? 0) + value;
    series.count = (series.count ?? 0) + 1;
    const counts = series.bucketCounts;
    if (counts === undefined) return;
    for (let i = 0; i < buckets.length; i += 1) {
      const bound = buckets[i];
      if (bound !== undefined && value <= bound) {
        counts[i] = (counts[i] ?? 0) + 1;
      }
    }
    counts[buckets.length] = (counts[buckets.length] ?? 0) + 1; // +Inf
  }

  collect(): MetricSample[] {
    const out: MetricSample[] = [];
    for (const series of this.#series.values()) {
      if (this.definition.kind === 'histogram') {
        out.push({
          name: this.definition.name,
          kind: this.definition.kind,
          labels: series.labels,
          histogram: {
            count: series.count ?? 0,
            sum: series.sum ?? 0,
            bucketCounts: series.bucketCounts ?? [],
          },
        });
      } else {
        out.push({
          name: this.definition.name,
          kind: this.definition.kind,
          labels: series.labels,
          value: series.value,
        });
      }
    }
    return out;
  }
}

/**
 * The registry. Every metric is declared before use, so an exporter and a
 * dashboard can know the full catalogue without waiting for a first sample.
 */
/**
 * Two declarations of one metric name must describe the same metric.
 *
 * Declaring the same metric twice is the ordinary idiom — two modules both want
 * the same counter, and both should get it. Declaring it twice DIFFERENTLY is
 * not: the second caller silently receives the first one's instrument, so its
 * extra label is dropped from every observation it makes and the series it
 * thinks it is writing does not exist.
 *
 * The kind conflict was already refused. This adds the two that were not:
 * disagreeing label sets, and disagreeing histogram buckets — a bucket
 * mismatch makes two callers' percentiles incomparable while looking fine.
 *
 * `help` is deliberately NOT compared. It is prose for an operator; refusing a
 * redeclaration over a reworded sentence would be a startup crash over a typo.
 */
export function assertCompatibleDefinition(
  existing: MetricDefinition,
  incoming: MetricDefinition,
): void {
  if (existing.kind !== incoming.kind) {
    throw new Error(
      `Metric '${incoming.name}' is already registered as a ${existing.kind}; cannot re-register as a ${incoming.kind}.`,
    );
  }

  const before = [...existing.labelNames].sort();
  const after = [...incoming.labelNames].sort();
  if (before.length !== after.length || before.some((name, index) => name !== after[index])) {
    throw new Error(
      `Metric '${incoming.name}' is already registered with labels [${before.join(', ')}]; cannot re-register with [${after.join(', ')}]. The second declaration would silently observe against the first one's labels.`,
    );
  }

  const bucketsBefore = existing.buckets;
  const bucketsAfter = incoming.buckets;
  if (bucketsBefore !== undefined && bucketsAfter !== undefined) {
    if (
      bucketsBefore.length !== bucketsAfter.length ||
      bucketsBefore.some((bound, index) => bound !== bucketsAfter[index])
    ) {
      throw new Error(
        `Metric '${incoming.name}' is already registered with different histogram buckets. Two bucket sets make the same percentile mean two things.`,
      );
    }
  }
}

export class MetricRegistry {
  readonly #instruments = new Map<string, MetricInstrument>();

  #declare(definition: MetricDefinition): MetricInstrument {
    const existing = this.#instruments.get(definition.name);
    if (existing !== undefined) {
      assertCompatibleDefinition(existing.definition, definition);
      return existing;
    }
    assertLabelsAllowed(Object.fromEntries(definition.labelNames.map((n) => [n, ''])));
    const instrument = new MetricInstrument(definition);
    this.#instruments.set(definition.name, instrument);
    return instrument;
  }

  counter(definition: Omit<MetricDefinition, 'kind'>): Counter {
    const instrument = this.#declare({ ...definition, kind: 'counter' });
    return {
      inc(labels = {}, by = 1): void {
        if (by < 0) throw new Error(`Counter '${definition.name}' cannot decrease.`);
        instrument.add(labels as Record<string, string>, by);
      },
    };
  }

  gauge(definition: Omit<MetricDefinition, 'kind'>): Gauge {
    const instrument = this.#declare({ ...definition, kind: 'gauge' });
    return {
      set(value, labels = {}): void {
        instrument.set(labels as Record<string, string>, value);
      },
      inc(labels = {}, by = 1): void {
        instrument.add(labels as Record<string, string>, by);
      },
      dec(labels = {}, by = 1): void {
        instrument.add(labels as Record<string, string>, -by);
      },
    };
  }

  histogram(definition: Omit<MetricDefinition, 'kind'>): Histogram {
    const instrument = this.#declare({ ...definition, kind: 'histogram' });
    return {
      observe(value, labels = {}): void {
        instrument.observe(labels as Record<string, string>, value);
      },
    };
  }

  /** A histogram with a stopwatch. `now` is injectable so tests are deterministic. */
  timer(
    definition: Omit<MetricDefinition, 'kind'>,
    now: () => number = (): number => Date.now(),
  ): Timer {
    const histogram = this.histogram({
      buckets: DEFAULT_DURATION_BUCKETS_SECONDS,
      ...definition,
    });
    return {
      start(labels = {}): () => void {
        const startedAt = now();
        return (): void => {
          histogram.observe((now() - startedAt) / 1000, labels);
        };
      },
      observeSeconds(seconds, labels = {}): void {
        histogram.observe(seconds, labels);
      },
    };
  }

  definitions(): MetricDefinition[] {
    return [...this.#instruments.values()].map((i) => i.definition);
  }

  collect(): MetricSample[] {
    return [...this.#instruments.values()].flatMap((i) => i.collect());
  }
}
