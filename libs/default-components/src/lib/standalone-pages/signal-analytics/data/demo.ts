// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The offline demonstration: two configured signals and findings for them.
 *
 * Used only when there is no writable backend (`SignalStore.offline`) — a
 * developer's browser, or a project whose Python manager has never run. The
 * page then shows
 * the whole interface with plausible content instead of an empty list plus an
 * error, which is what makes it reviewable before a project exists.
 *
 * The numbers are generated from the same synthetic signal the chart falls back
 * to (`history.ts`), so the anomaly markers actually sit on the excursion drawn
 * under them rather than at arbitrary times.
 */
import {
  blankSignal,
  type AnalysisResult,
  type LiveState,
  type SignalConfig,
  type SignalStatus
} from '../types.js';
import { DEMO_ANOMALY_AT, DEMO_CYCLE_MS, demoSpan } from './history.js';

/** Fraction of a cycle an occurrence band covers. */
const OCCURRENCE_DUTY = 0.8;

/** Samples per cycle in the fabricated analysis — only used for `index`. */
const DEMO_SAMPLES_PER_CYCLE = 60;

/** One joint furnace signal and one univariate pump — the two analysis shapes. */
export function demoSignals(): SignalConfig[] {
  return [
    {
      ...blankSignal('demo-furnace-batch'),
      dp: 'SigAnalysis_demo-furnace-batch',
      label: 'Furnace 01 — batch (joint)',
      dpes: [
        'System1:SigSim_Furnace01.temperature',
        'System1:SigSim_Furnace01.power',
        'System1:SigSim_Furnace01.gasFlow'
      ],
      engine: 'numpy',
      window: 120
    },
    {
      ...blankSignal('demo-pump-vibration'),
      dp: 'SigAnalysis_demo-pump-vibration',
      label: 'Pump P-101 — vibration',
      dpes: ['System1:ExampleDP_Trend1.'],
      engine: 'numpy',
      window: 60,
      realtime: { enabled: false, bufferPoints: 2000, throttleMs: 5000 }
    }
  ];
}

/** A finished analysis for a demo signal, consistent with the demo curve. */
export function demoResult(config: SignalConfig): AnalysisResult {
  const { from, to } = demoSpan();
  const anomalyStart = from + DEMO_ANOMALY_AT;
  const cycles = Math.floor((to - from) / DEMO_CYCLE_MS);
  // Every cycle of the demo curve, not a sample of them: a recurrence band that
  // stopped a third of the way across the chart would read as a bug in the
  // detection rather than as a cap in the fixture.
  const occurrences = Array.from({ length: cycles }, (_, index) => ({
    start: from + index * DEMO_CYCLE_MS,
    end: from + index * DEMO_CYCLE_MS + DEMO_CYCLE_MS * OCCURRENCE_DUTY,
    index: index * DEMO_SAMPLES_PER_CYCLE
  }));

  return {
    requestId: 'demo',
    dpe: config.dpes[0] ?? '',
    dpes: config.dpes,
    engine: config.engine,
    window: config.window,
    sampleCount: 4800,
    from,
    to,
    threshold: 2.4,
    anomalies: [
      {
        rank: 1,
        start: anomalyStart,
        end: anomalyStart + DEMO_CYCLE_MS,
        index: 1000,
        score: 8.1,
        severity: 3.4,
        ...(config.dpes.length > 1
          ? {
              contributions: Object.fromEntries(
                config.dpes.map((dpe, index) => [
                  dpe,
                  index === 1
                    ? 0.61
                    : 0.39 / Math.max(config.dpes.length - 1, 1)
                ])
              )
            }
          : {})
      }
    ],
    recurrences: [
      {
        rank: 1,
        id: 'motif-1',
        count: occurrences.length,
        distance: 0.44,
        periodMs: DEMO_CYCLE_MS,
        occurrences
      }
    ],
    profile: null,
    notes: ['demonstration data — no backend connected'],
    computedAt: new Date().toISOString(),
    durationMs: 1840
  };
}

export function demoStatus(config: SignalConfig): SignalStatus {
  return {
    state: 'done',
    requestId: 'demo',
    progress: 100,
    message: '1 anomaly, 1 recurrence',
    engine: config.engine,
    engineRequested: config.engine,
    fallback: false,
    runtime: 'demonstration mode — no Python manager connected',
    updatedAt: new Date().toISOString(),
    stepMs: 1000,
    sampleCount: 4800
  };
}

export function demoLive(config: SignalConfig): LiveState | null {
  if (!config.realtime.enabled) return null;
  const now = Date.now();
  return {
    updatedAt: new Date(now).toISOString(),
    engine: config.engine,
    armed: true,
    score: 1.1,
    threshold: 2.4,
    severity: 0.46,
    anomaly: false,
    stepMs: 1000,
    bufferPoints: 2000,
    recent: Array.from({ length: 60 }, (_, index) => ({
      t: now - (60 - index) * 5000,
      s: 0.8 + Math.abs(Math.sin(index / 7)) * 0.9
    })),
    events: []
  };
}
