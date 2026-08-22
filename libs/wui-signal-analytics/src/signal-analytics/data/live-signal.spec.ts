// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What has to hold for the curves to keep growing correctly.
 *
 * The failure this guards against is not "no update" — that is obvious the
 * moment you look at the page. It is the quiet ones: a value plotted at arrival
 * time instead of its source time, the `answer` emission appended a second time,
 * tails from the previously selected signal drawn under the new one, one bad
 * element of a joint signal killing the others' tails, or a subscription left
 * running after the element list changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { LiveSignal } from './live-signal.js';

/** A callback the test does not care about (the tails are read via `current`). */
function noop(): void {
  /* intentionally empty */
}

const DPE = 'System1:ExampleDP_Trend1.';
const OTHER = 'System1:ExampleDP_Arg1.';
const STIME = `${DPE}:_online.._stime`;

interface Emission {
  dp: string[];
  value: unknown[];
}

/** A stand-in for the slice of `OaRxJsApi` the live tails use. */
function fakeApi() {
  const streams = new Map<string, Subject<Emission>>();
  let connects = 0;
  const api = {
    dpConnect(dpes: string[]) {
      connects += 1;
      const subject = new Subject<Emission>();
      streams.set(dpes[0], subject);
      return subject.asObservable();
    }
  };
  return {
    // The class only ever calls dpConnect; the cast keeps the test honest about that.
    api: api as never,
    emit(dpe: string, value: unknown, stime?: unknown) {
      const dp = [dpe];
      const values: unknown[] = [value];
      if (stime !== undefined) {
        dp.push(`${dpe}:_online.._stime`);
        values.push(stime);
      }
      streams.get(dpe)?.next({ dp, value: values });
    },
    fail(dpe: string) {
      streams.get(dpe)?.error(new Error('unresolvable name'));
    },
    get connects() {
      return connects;
    },
    isClosed(dpe: string) {
      return streams.get(dpe)?.observed === false;
    }
  };
}

/** The tail of one element, or [] — most tests look at a single element. */
function tailOf(live: LiveSignal, dpe: string) {
  return live.current.get(dpe) ?? [];
}

describe('LiveSignal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plots a value at its source time, not at arrival', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    const seen: number[] = [];
    live.follow([DPE], (tails) => seen.push(tails.get(DPE)?.length ?? 0));

    const sourceTime = new Date('2026-08-18T10:00:00Z');
    backend.emit(DPE, 42, sourceTime);

    expect(tailOf(live, DPE)).toEqual([{ t: sourceTime.getTime(), v: 42 }]);
    expect(seen).toEqual([1]);
  });

  it('falls back to arrival time when the element has no readable source time', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);

    backend.emit(DPE, 7);

    expect(tailOf(live, DPE)).toHaveLength(1);
    expect(tailOf(live, DPE)[0].v).toBe(7);
    expect(tailOf(live, DPE)[0].t).toBeGreaterThan(0);
  });

  it('accepts a source time as an ISO string or as epoch milliseconds', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);

    backend.emit(DPE, 1, '2026-08-18T10:00:00.000Z');
    backend.emit(DPE, 2, Date.parse('2026-08-18T10:00:01.000Z'));

    expect(tailOf(live, DPE).map((s) => s.v)).toEqual([1, 2]);
    expect(tailOf(live, DPE)[1].t - tailOf(live, DPE)[0].t).toBe(1000);
  });

  it('ignores a repeated instant — the answer emission must not double the point', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);

    const at = Date.parse('2026-08-18T10:00:00Z');
    backend.emit(DPE, 5, at);
    backend.emit(DPE, 5, at);
    backend.emit(DPE, 6, at - 1000);

    expect(tailOf(live, DPE)).toEqual([{ t: at, v: 5 }]);
  });

  it('unwraps a { value } envelope and maps booleans to 1/0', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);

    backend.emit(DPE, { value: 12.5 }, Date.parse('2026-08-18T10:00:00Z'));
    backend.emit(DPE, true, Date.parse('2026-08-18T10:00:01Z'));

    expect(tailOf(live, DPE).map((s) => s.v)).toEqual([12.5, 1]);
  });

  it('drops a non-numeric value instead of plotting it as zero', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);

    backend.emit(DPE, 'RUNNING', Date.parse('2026-08-18T10:00:00Z'));

    expect(tailOf(live, DPE)).toEqual([]);
  });

  it('throttles notifications without losing the samples behind them', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    const notified: number[] = [];
    live.follow([DPE], (tails) => notified.push(tails.get(DPE)?.length ?? 0));

    const base = Date.parse('2026-08-18T10:00:00Z');
    for (let index = 0; index < 20; index += 1) {
      backend.emit(DPE, index, base + index * 100);
    }

    // One immediate notification; the other nineteen collapse into the trailing one.
    expect(notified).toEqual([1]);
    expect(tailOf(live, DPE)).toHaveLength(20);

    vi.advanceTimersByTime(1000);
    expect(notified).toEqual([1, 20]);
  });

  it('keeps one tail per element of a joint signal', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE, OTHER], noop);

    const at = Date.parse('2026-08-18T10:00:00Z');
    backend.emit(DPE, 1, at);
    backend.emit(OTHER, 2, at);
    backend.emit(OTHER, 3, at + 1000);

    expect(tailOf(live, DPE).map((s) => s.v)).toEqual([1]);
    expect(tailOf(live, OTHER).map((s) => s.v)).toEqual([2, 3]);
    expect(backend.connects).toBe(2);
  });

  it('one failing element costs its own tail, never the others', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE, OTHER], noop);

    const at = Date.parse('2026-08-18T10:00:00Z');
    backend.emit(DPE, 1, at);
    backend.fail(DPE);
    backend.emit(OTHER, 2, at);

    expect(live.current.has(DPE)).toBe(false);
    expect(tailOf(live, OTHER).map((s) => s.v)).toEqual([2]);
  });

  it('switching the element list drops the previous tails and subscriptions', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);
    backend.emit(DPE, 1, Date.parse('2026-08-18T10:00:00Z'));
    expect(tailOf(live, DPE)).toHaveLength(1);

    live.follow([OTHER], noop);

    expect(live.current.has(DPE)).toBe(false);
    expect(backend.isClosed(DPE)).toBe(true);
    expect(backend.connects).toBe(2);
  });

  it('following the same list again keeps the existing subscriptions', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);
    backend.emit(DPE, 1, Date.parse('2026-08-18T10:00:00Z'));

    live.follow([DPE], noop);

    expect(backend.connects).toBe(1);
    expect(tailOf(live, DPE)).toHaveLength(1);
  });

  it('reset clears the tails an archive re-read now covers, and keeps streaming', () => {
    const backend = fakeApi();
    const live = new LiveSignal(backend.api);
    live.follow([DPE], noop);
    backend.emit(DPE, 1, Date.parse('2026-08-18T10:00:00Z'));

    live.reset();
    expect(tailOf(live, DPE)).toEqual([]);

    backend.emit(DPE, 2, Date.parse('2026-08-18T10:00:05Z'));
    expect(tailOf(live, DPE).map((s) => s.v)).toEqual([2]);
  });

  it('does nothing at all without a backend (demonstration mode)', () => {
    const live = new LiveSignal(null);
    live.follow([DPE], () => expect.unreachable('no backend, no notification'));
    expect(live.current.size).toBe(0);
  });
});

describe('the stime leaf', () => {
  it('is subscribed alongside each value', () => {
    const subscribed: string[][] = [];
    const api = {
      dpConnect(dpes: string[]) {
        subscribed.push(dpes);
        return new Subject().asObservable();
      }
    } as never;

    new LiveSignal(api).follow([DPE], noop);

    expect(subscribed).toEqual([[DPE, STIME]]);
  });
});
