// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page's half of the contract with the Python manager.
 *
 * One WinCC OA datapoint of type `SignalAnalysis` per configured signal, six
 * String leaves carrying JSON. The page owns `name`, `config` and `command`; the
 * manager owns `status`, `result` and `live`. No leaf is written by both, so
 * neither side can overwrite the other's work.
 *
 * The Python mirror is `backend/python/signal_analytics/protocol.py` — the two
 * files are one contract seen from either end, so a field added here has to be
 * added there in the same change.
 *
 * Note what is NOT exchanged: the samples. The page reads the analysed period
 * itself with `dpGetPeriod` (see `data/history.ts`), and findings carry absolute
 * timestamps, so they land on the page's own curve without the manager ever
 * having to ship a copy of it through a String datapoint.
 */

/**
 * DP type backing one configured signal.
 *
 * Created by the **manager**, not by the page: creating a datapoint or a DP type
 * is an engineering operation, and the WebUI runtime API (`OaRxJsApi`) offers no
 * such call — it reads, subscribes and writes values, nothing more. So the page
 * asks, over {@link HUB_DP}, and the manager engineers.
 */
export const DP_TYPE = 'SignalAnalysis';

/** Leaves of {@link DP_TYPE}, in the order the type declares them. */
export const LEAVES = [
  'name',
  'config',
  'command',
  'status',
  'result',
  'live'
] as const;

/** Prefix of every per-signal datapoint, so they group in PARA and in the page. */
export const DP_PREFIX = 'SigAnalysis_';

/**
 * The manager's provisioning hub: ONE datapoint, of its own type, created by the
 * manager on start.
 *
 * It exists because the page cannot create datapoints. `request` carries what the
 * page wants engineered, `response` the outcome, `info` the manager's own
 * identity card — which is also how the page knows a manager is running at all
 * (no manager, no hub, and the page says it is in demonstration mode).
 */
export const HUB_DP_TYPE = 'SignalAnalyticsHub';

/** The single instance of {@link HUB_DP_TYPE}. */
export const HUB_DP = 'SignalAnalyticsHub';

/** Leaves of {@link HUB_DP_TYPE}, in the order the type declares them. */
export const HUB_LEAVES = ['request', 'response', 'info'] as const;

/** Protocol version of the hub exchange; bumped when the shape changes. */
export const HUB_VERSION = 1;

/** What the page writes on `request` to have a datapoint engineered. */
export interface HubRequest {
  requestId: string;
  op: 'create' | 'delete';
  issuedAt: string;
  user: string;
  /** `create` — the signal to provision. Its `dp` is assigned by the manager. */
  config?: SignalConfig;
  /** `delete` — the datapoint to drop. */
  dp?: string;
}

/** What the manager writes on `response`, echoing the request id. */
export interface HubResponse {
  requestId: string;
  op: 'create' | 'delete' | '';
  ok: boolean;
  /** The datapoint created, or the one deleted. */
  dp: string;
  error?: string;
  at: string;
}

/** What the manager writes on `info` when it starts. */
export interface HubInfo {
  version: number;
  dpType: string;
  prefix: string;
  startedAt: string;
  engines?: Record<string, EngineAvailability>;
}

/**
 * Which analysis back-end runs on the server.
 *
 * - `numpy` — matrix profile, built into the manager. Always available.
 * - `stumpy` — the same quantity computed by STUMPY: much faster on long
 *   periods, but an optional `pip install` on the server.
 * - `chronos` — Amazon's pretrained forecasting model: flags what was *not
 *   predictable* rather than what never recurred. Needs `torch`, and it is a
 *   multi-gigabyte install.
 *
 * A missing engine is not an error: the manager analyses with `numpy` and
 * reports the substitution in {@link SignalStatus.fallbackReason}.
 */
export type EngineId = 'numpy' | 'stumpy' | 'chronos';

export const ENGINE_IDS: readonly EngineId[] = ['numpy', 'stumpy', 'chronos'];

/** A configured signal — what the page persists on the `config` leaf. */
export interface SignalConfig {
  /** Slug, also the suffix of the backing datapoint name. */
  id: string;
  /** Backing datapoint, assigned by the store on create. */
  dp?: string;
  label: string;
  /**
   * The analysed datapoint elements. One = univariate; several = ONE joint
   * analysis over all of them (mSTAMP) — the point of the list is anomalies
   * that only exist in the correlation between signals, which no per-signal
   * analysis can see.
   */
  dpes: string[];
  enabled: boolean;
  engine: EngineId;
  /** Subsequence length in samples: the length of the shape being looked for. */
  window: number;
  history: { hours: number; maxPoints: number };
  anomalies: { max: number; sensitivity: number };
  recurrences: { max: number; radius: number };
  realtime: { enabled: boolean; bufferPoints: number; throttleMs: number };
  chronos: { model: string; context: number; horizon: number };
}

/** What the page writes on `command` to make the manager act. */
export interface SignalCommand {
  requestId: string;
  action: 'analyze' | 'ping';
  issuedAt: string;
  user: string;
}

export type RunState = 'idle' | 'queued' | 'running' | 'done' | 'error';

/** Availability of one engine on the server, as the manager reports it. */
export interface EngineAvailability {
  available: boolean;
  reason: string;
}

/** The `status` leaf: what the manager is doing with the last command. */
export interface SignalStatus {
  state: RunState;
  requestId: string;
  progress: number;
  message: string;
  /** The engine that actually ran. */
  engine: string;
  /** The engine the config asked for — differs from `engine` on a fallback. */
  engineRequested: string;
  fallback: boolean;
  fallbackReason?: string;
  /** Python/NumPy versions and host, for support. */
  runtime: string;
  updatedAt: string;
  engines?: Record<string, EngineAvailability>;
  durationMs?: number;
  /** Sample interval of the analysed grid — turns a window into a duration. */
  stepMs?: number;
  rawCount?: number;
  sampleCount?: number;
}

/** One anomaly: a stretch of signal that resembles nothing else in the period. */
export interface Anomaly {
  rank: number;
  /** Epoch ms. */
  start: number;
  end: number;
  index: number;
  score: number;
  /** Score as a multiple of the threshold — the comparable number. */
  severity: number | null;
  /**
   * Joint analyses only: each element's share (0..1) in the strangeness —
   * "which signal do I go and look at" is the operator's next question.
   */
  contributions?: Record<string, number>;
}

/** One occurrence of a recurring shape. */
export interface Occurrence {
  start: number;
  end: number;
  index: number;
}

/** One recurrence: a shape that happens several times in the period. */
export interface Recurrence {
  rank: number;
  id: string;
  count: number;
  /** Distance between the two closest occurrences — smaller is a tighter match. */
  distance: number;
  /** Median gap between occurrences: the cycle time, when there is one. */
  periodMs: number | null;
  occurrences: Occurrence[];
}

/** The score curve under the chart, downsampled by the manager. */
export interface ProfileBand {
  t: number[];
  v: number[];
  window: number;
}

/** The `result` leaf: everything one historical analysis found. */
export interface AnalysisResult {
  requestId: string;
  dpe: string;
  /** The analysed elements — present on results written by the multi-signal manager. */
  dpes?: string[];
  engine: string;
  window: number;
  sampleCount: number;
  from: number;
  to: number;
  threshold: number;
  anomalies: Anomaly[];
  recurrences: Recurrence[];
  profile: ProfileBand | null;
  notes: string[];
  computedAt: string;
  durationMs: number;
}

/** One live evaluation kept for the sparkline. */
export interface LiveScore {
  t: number;
  s: number;
}

/** A live excursion above the threshold, extended while it lasts. */
export interface LiveEvent {
  start: number;
  end: number;
  score: number;
  threshold: number;
  at: string;
}

/** The `live` leaf: the rolling real-time watch. */
export interface LiveState {
  updatedAt: string;
  engine: string;
  /** False until a historical analysis has given the watch a reference. */
  armed: boolean;
  reason?: string;
  score?: number;
  threshold?: number;
  severity?: number | null;
  anomaly?: boolean;
  stepMs?: number;
  window?: { start: number; end: number };
  bufferPoints?: number;
  recent: LiveScore[];
  events: LiveEvent[];
}

/** A configured signal together with everything the manager has said about it. */
export interface SignalView {
  config: SignalConfig;
  status: SignalStatus | null;
  result: AnalysisResult | null;
  live: LiveState | null;
}

/** Sensible starting point for a new signal — an hour of history, a small window. */
export function blankSignal(id = ''): SignalConfig {
  return {
    id,
    label: '',
    dpes: [''],
    enabled: true,
    engine: 'numpy',
    window: 64,
    history: { hours: 24, maxPoints: 20_000 },
    anomalies: { max: 10, sensitivity: 3 },
    recurrences: { max: 5, radius: 3 },
    realtime: { enabled: true, bufferPoints: 2000, throttleMs: 5000 },
    chronos: { model: 'amazon/chronos-bolt-small', context: 512, horizon: 32 }
  };
}

/**
 * Fill in whatever an older or hand-edited `config` leaf is missing.
 *
 * The store reads JSON written by a previous version of this page (and, in
 * practice, by whoever edited the datapoint in PARA), so every nested group is
 * merged over the defaults rather than trusted to exist.
 */
export function withDefaults(
  raw: Partial<SignalConfig> & { id: string; dpe?: string }
): SignalConfig {
  const base = blankSignal(raw.id);
  // `dpes` is the current form; a lone `dpe` string is a config leaf written
  // before the multi-signal feature — data at rest, still valid.
  const dpes = (raw.dpes ?? (raw.dpe ? [raw.dpe] : [])).filter(
    (item) => item.trim() !== ''
  );
  return {
    ...base,
    ...raw,
    dpes: dpes.length > 0 ? dpes : [''],
    engine: ENGINE_IDS.includes(raw.engine as EngineId)
      ? (raw.engine as EngineId)
      : base.engine,
    history: { ...base.history, ...raw.history },
    anomalies: { ...base.anomalies, ...raw.anomalies },
    recurrences: { ...base.recurrences, ...raw.recurrences },
    realtime: { ...base.realtime, ...raw.realtime },
    chronos: { ...base.chronos, ...raw.chronos }
  };
}

/** Is this signal being worked on right now? */
export function isBusy(status: SignalStatus | null): boolean {
  return status?.state === 'queued' || status?.state === 'running';
}
