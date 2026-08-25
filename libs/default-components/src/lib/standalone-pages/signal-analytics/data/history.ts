// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The curve under the findings: the analysed period, read by the page itself.
 *
 * The manager never ships the samples back — it would mean a few hundred
 * kilobytes of JSON through a String datapoint for data the browser can read
 * directly. So the page asks the archive for the same window the manager
 * analysed (`dpGetPeriod`, the mechanism the audit-trail, fleet and report pages
 * already use) and the findings, which carry absolute timestamps, land on it.
 *
 * When there is nothing to read — no archive on that element, no backend at all
 * — a synthetic signal is drawn instead: a repeated cycle with one excursion,
 * matching the demonstration findings in `demo.ts`. The page labels it as such;
 * the alternative is a blank panel that says nothing about whether the feature
 * works.
 */
import { OaRxJsApi } from '@etm-professional-control/oa-rx-js-api';
import { firstValueFrom } from 'rxjs';

/** Archived-value attribute appended to a DPE for `dpGetPeriod`. */
const VALUE_ATTR = ':_original.._value';

/** count = 0 → every archived value in the period. */
const ALL_VALUES = 0;

/** Points kept for the chart: more than a screen can resolve is wasted work. */
const CHART_MAX_POINTS = 3000;

const HOUR_MS = 3_600_000;

/** Period of the repeated shape in the synthetic fallback curve. */
export const DEMO_CYCLE_MS = 600_000;

/** Offset of the synthetic excursion inside the demo period. */
export const DEMO_ANOMALY_AT = 3 * HOUR_MS;

/** Sample of the analysed signal. */
export interface Sample {
  /** Epoch ms. */
  t: number;
  v: number;
}

export interface HistorySeries {
  samples: Sample[];
  /** True when the curve was synthesised because the archive returned nothing. */
  synthetic: boolean;
}

/** One curve per analysed element, in configuration order. */
export interface HistoryBundle {
  series: { dpe: string; samples: Sample[]; synthetic: boolean }[];
  /** True when EVERY curve is synthetic — the "no archive at all" banner case. */
  synthetic: boolean;
}

/** The demonstration window: the last six hours. */
export function demoSpan(): { from: number; to: number } {
  const to = Date.now();
  return { from: to - 6 * HOUR_MS, to };
}

function toMs(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return new Date(String(value)).getTime();
}

/**
 * Normalise a `dpGetPeriod` payload into ascending samples.
 *
 * The call answers `{ data, dataTime }` — flat arrays for one element, arrays of
 * arrays when several were requested — so the first level is unwrapped before
 * anything else. Non-finite values are dropped rather than plotted as gaps at
 * zero.
 */
function toSamples(raw: unknown): Sample[] {
  const payload = raw as { data?: unknown; dataTime?: unknown } | undefined;
  if (
    !payload ||
    !Array.isArray(payload.data) ||
    !Array.isArray(payload.dataTime)
  )
    return [];
  const values = (
    Array.isArray(payload.data[0]) ? payload.data[0] : payload.data
  ) as unknown[];
  const times = (
    Array.isArray(payload.dataTime[0]) ? payload.dataTime[0] : payload.dataTime
  ) as unknown[];

  const samples: Sample[] = [];
  for (const [index, value] of values.entries()) {
    const t = toMs(times[index]);
    const v = Number(value);
    if (Number.isFinite(t) && Number.isFinite(v)) samples.push({ t, v });
  }
  return samples.sort((a, b) => a.t - b.t);
}

/** Keep at most {@link CHART_MAX_POINTS}, evenly across the period. */
function thin(samples: Sample[]): Sample[] {
  if (samples.length <= CHART_MAX_POINTS) return samples;
  const step = Math.ceil(samples.length / CHART_MAX_POINTS);
  return samples.filter((_sample, index) => index % step === 0);
}

/**
 * Read `[from, to]` of a datapoint element.
 *
 * Never throws: a missing archive, a mistyped element and an absent backend all
 * end the same way — a synthetic curve and `synthetic: true` — because the page
 * shows findings over a curve, and no curve at all would hide findings that are
 * perfectly valid.
 */
export async function readHistory(
  api: OaRxJsApi | null,
  dpe: string,
  from: number,
  to: number
): Promise<HistorySeries> {
  if (api && dpe !== '') {
    try {
      const raw = await firstValueFrom(
        api.dpGetPeriod(
          new Date(from),
          new Date(to),
          ALL_VALUES,
          dpe + VALUE_ATTR
        )
      );
      const samples = thin(toSamples(raw));
      if (samples.length > 1) return { samples, synthetic: false };
    } catch {
      /* falls through to the synthetic curve */
    }
  }
  return { samples: syntheticSeries(from, to), synthetic: true };
}

/**
 * Read the same period for every analysed element of a joint signal.
 *
 * Sequential rather than parallel on purpose: each read is one archive query,
 * and a signal has at most a handful of elements — bursting them concurrently
 * buys milliseconds and costs the archive manager a spike.
 *
 * Synthetic fallbacks are phase-shifted per element so a demo joint signal
 * shows three visibly *different* curves rather than one drawn thrice.
 */
export async function readHistoryMany(
  api: OaRxJsApi | null,
  dpes: string[],
  from: number,
  to: number
): Promise<HistoryBundle> {
  const series: HistoryBundle['series'] = [];
  for (const [index, dpe] of dpes.entries()) {
    const one = await readHistory(api, dpe, from, to);
    series.push({
      dpe,
      samples: one.synthetic ? syntheticSeries(from, to, index) : one.samples,
      synthetic: one.synthetic
    });
  }
  return {
    series,
    synthetic: series.length > 0 && series.every((entry) => entry.synthetic)
  };
}

/**
 * A repeated cycle with one excursion — the shape the page is built to explain.
 *
 * Deterministic (a fixed pseudo-random sequence, not `Math.random`): the curve
 * has to be identical from one render to the next, otherwise the demonstration
 * findings would drift off the anomaly they point at.
 */
export function syntheticSeries(
  from: number,
  to: number,
  phaseIndex = 0
): Sample[] {
  const span = Math.max(to - from, DEMO_CYCLE_MS * 4);
  const count = Math.min(
    CHART_MAX_POINTS,
    Math.max(600, Math.round(span / 5000))
  );
  const step = span / (count - 1);
  const anomalyStart = from + DEMO_ANOMALY_AT;
  const anomalyEnd = anomalyStart + DEMO_CYCLE_MS;

  const phaseShift = (phaseIndex * Math.PI) / 3;
  let seed = 12_345 + phaseIndex * 977;
  const noise = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };

  const samples: Sample[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = from + index * step;
    const phase = ((t - from) % DEMO_CYCLE_MS) / DEMO_CYCLE_MS;
    const base =
      50 +
      12 * Math.sin(2 * Math.PI * phase + phaseShift) +
      3 * Math.sin(6 * Math.PI * phase);
    const excursion =
      t >= anomalyStart && t <= anomalyEnd
        ? 22 * Math.sin((6 * Math.PI * (t - anomalyStart)) / DEMO_CYCLE_MS)
        : 0;
    samples.push({
      t: Math.round(t),
      v: Number((base + excursion + noise() * 1.5).toFixed(3))
    });
  }
  return samples;
}
