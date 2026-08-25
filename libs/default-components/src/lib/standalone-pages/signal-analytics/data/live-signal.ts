// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The live tail of the analysed signal: the samples that arrived since the read.
 *
 * The chart's curve comes from the archive, read once for the analysed period.
 * Without this, everything the process did afterwards is invisible until the
 * page is reloaded — which is exactly the wrong behaviour for a page whose other
 * half is a *live* watch.
 *
 * So each of the selected signal's elements is subscribed with `dpConnect`, and each new
 * value is appended to a bounded buffer the chart draws past the end of the
 * archived curve. No polling, and no second read of the archive: the archive is
 * asked again only when a new analysis moves the period.
 *
 * **Value and source time are subscribed together.** A `dpConnect` emission
 * carries `{ dp, value }` and no timestamp, so plotting on arrival time would
 * bend the curve by the transport latency and, worse, by whatever the browser
 * was doing at that moment. Subscribing `:_online.._stime` alongside the value —
 * — puts each point at the
 * instant the process produced it. Arrival time remains the fallback for an
 * element whose source time is not readable.
 *
 * Emissions are **throttled** before they reach the chart: a signal changing at
 * 10 Hz would otherwise mean ten echarts renders a second for a curve whose
 * points are a pixel apart.
 */
import { OaRxJsApi } from '@etm-professional-control/oa-rx-js-api';
import { Subscription } from 'rxjs';
import type { Sample } from './history.js';

/** Source-time attribute subscribed alongside the value. */
const STIME_ATTR = ':_online.._stime';

/** Points kept in the tail — beyond this, the oldest are dropped. */
const MAX_LIVE_POINTS = 5000;

/** Minimum delay between two notifications to the chart. */
const NOTIFY_THROTTLE_MS = 1000;

/** An emission as oa-rx-js-api delivers it. */
interface DpEmission {
  dp: string[];
  value: unknown[];
}

/** Unwrap a `{ value }` envelope and coerce to a finite number, or `null`. */
function numberOf(raw: unknown): number | null {
  const unwrapped =
    raw && typeof raw === 'object' && 'value' in raw
      ? (raw as { value: unknown }).value
      : raw;
  if (typeof unwrapped === 'boolean') return unwrapped ? 1 : 0;
  const parsed = Number(unwrapped);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A WinCC OA source time (Date, ISO string or epoch) as epoch ms, or `null`. */
function timeOf(raw: unknown): number | null {
  const unwrapped =
    raw && typeof raw === 'object' && 'value' in raw
      ? (raw as { value: unknown }).value
      : raw;
  if (unwrapped instanceof Date) {
    const ms = unwrapped.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof unwrapped === 'number')
    return Number.isFinite(unwrapped) ? unwrapped : null;
  if (typeof unwrapped === 'string' && unwrapped !== '') {
    const parsed = Date.parse(unwrapped);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Follows one datapoint element and accumulates what it has done since.
 *
 * One instance per page; {@link follow} switches it to another element and
 * clears the buffer, because a tail belonging to the previous signal drawn under
 * the new one would be worse than no tail at all.
 */
export class LiveSignal {
  private readonly api: OaRxJsApi | null;
  private subscriptions = new Map<string, Subscription>();
  private tails = new Map<string, Sample[]>();
  private key = '';
  private notify: ((tails: ReadonlyMap<string, Sample[]>) => void) | null =
    null;
  private timer = 0;
  private pending = false;

  constructor(api: OaRxJsApi | null) {
    this.api = api;
  }

  /** The tails as they stand, per element, oldest first. */
  get current(): ReadonlyMap<string, Sample[]> {
    return this.tails;
  }

  /**
   * Follow *dpes*, calling *onChange* (throttled) as values arrive.
   *
   * One `dpConnect` per element rather than one batched call: a batch fails as
   * a whole on the first unresolvable name, and a joint signal is exactly where
   * a half-typed element sneaks in next to two valid ones — isolated, it costs
   * its own tail and nothing else.
   *
   * Following the list already followed is a no-op, so the page may call this
   * from `updated()` without tearing the subscriptions down on every render.
   */
  follow(
    dpes: string[],
    onChange: (tails: ReadonlyMap<string, Sample[]>) => void
  ): void {
    const wanted = dpes.filter((dpe) => dpe !== '');
    const key = wanted.join('|');
    if (key === this.key && this.notify !== null) {
      this.notify = onChange;
      return;
    }
    this.stop();
    this.notify = onChange;
    this.key = key;
    if (!this.api || wanted.length === 0) return;

    for (const dpe of wanted) {
      this.tails.set(dpe, []);
      try {
        const subscription = this.api
          .dpConnect([dpe, dpe + STIME_ATTR], true)
          .subscribe({
            next: (emission: unknown) =>
              this.absorb(dpe, emission as DpEmission),
            error: () => {
              // This element's tail dies alone; the others keep streaming.
              this.subscriptions.get(dpe)?.unsubscribe();
              this.subscriptions.delete(dpe);
              this.tails.delete(dpe);
            }
          });
        this.subscriptions.set(dpe, subscription);
      } catch {
        this.tails.delete(dpe);
      }
    }
  }

  /** Drop the tails without unsubscribing — used when a new analysis re-reads them. */
  reset(): void {
    for (const dpe of this.tails.keys()) this.tails.set(dpe, []);
  }

  stop(): void {
    for (const subscription of this.subscriptions.values())
      subscription.unsubscribe();
    this.subscriptions.clear();
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.pending = false;
    this.tails = new Map();
    this.key = '';
  }

  private absorb(dpe: string, emission: DpEmission): void {
    if (!Array.isArray(emission?.dp) || !Array.isArray(emission?.value)) return;

    let value: number | null = null;
    let time: number | null = null;
    for (const [index, name] of emission.dp.entries()) {
      // Matched on the suffix rather than on the whole name: WinCC OA echoes a
      // name back in its own shape (system prefix, completed config part), so
      // comparing against the string that was subscribed misses.
      if (String(name).endsWith('_stime')) time = timeOf(emission.value[index]);
      else value ??= numberOf(emission.value[index]);
    }
    if (value === null) return;

    const tail = this.tails.get(dpe);
    if (!tail) return;
    const at = time ?? Date.now();
    const last = tail.at(-1);
    // The initial `answer` emission repeats the current value, and an element
    // can re-emit without its source time moving; either way the same instant
    // must not be appended twice.
    if (last && at <= last.t) return;

    this.tails.set(dpe, [...tail, { t: at, v: value }].slice(-MAX_LIVE_POINTS));
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== 0) {
      this.pending = true;
      return;
    }
    this.notify?.(new Map(this.tails));
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (!this.pending) return;
      this.pending = false;
      this.notify?.(new Map(this.tails));
    }, NOTIFY_THROTTLE_MS);
  }
}
