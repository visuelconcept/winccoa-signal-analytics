// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Formatting shared by the panels.
 *
 * Durations get their own function rather than a `toFixed` at each call site
 * because this page prints them across ten orders of magnitude — a sample step
 * of 200 ms, a window of three minutes, a cycle of six hours — and one scale
 * that reads well for all three does not exist. So the unit follows the value.
 */

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECOND_MS = 1000;
const MINUTE_MS = SECONDS_PER_MINUTE * SECOND_MS;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;

/** Below this many seconds a duration keeps a decimal, above it rounds. */
const SUB_TEN = 10;

/** Decimals on a distance/score — two is where the digits stop meaning anything. */
export const SCORE_DECIMALS = 2;

const PERCENT = 100;

/** The `2m` of `sqrt(2m)`, the ceiling of the z-normalised distance metric. */
const FULL_TURN = 2;

/** A duration in milliseconds, in the largest unit that keeps it readable. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < SECOND_MS) return `${Math.round(ms)} ms`;
  if (ms < MINUTE_MS)
    return `${(ms / SECOND_MS).toFixed(ms < SUB_TEN * SECOND_MS ? 1 : 0)} s`;
  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    const seconds = Math.round((ms % MINUTE_MS) / SECOND_MS);
    return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  }
  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.round((ms % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  return `${(ms / DAY_MS).toFixed(1)} d`;
}

/** Date and time of an epoch-ms instant, to the second. */
export function dateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/** Time only — for a list of findings that all sit in the same period. */
export function timeOfDay(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/** An ISO instant as local date+time; empty input stays empty. */
export function isoDateTime(iso: string): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : dateTime(parsed);
}

/**
 * A severity as a multiplier of the threshold ("×3.4").
 *
 * The raw distance means nothing without the threshold beside it, and the
 * threshold changes with the signal, the window and the sensitivity — the
 * multiple is the one number that compares across all of them.
 */
export function severity(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : `×${value.toFixed(1)}`;
}

/** A raw distance or residual score, to a fixed number of decimals. */
export function score(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : value.toFixed(SCORE_DECIMALS);
}

/** A match distance as a 0–100 % closeness, for a recurrence row. */
export function closeness(distance: number, window: number): string {
  // The metric's ceiling is sqrt(2m): a distance of 0 is identical, sqrt(2m) is
  // as unlike as two z-normalised shapes can be.
  const ceiling = Math.sqrt(FULL_TURN * Math.max(window, 1));
  const ratio = 1 - Math.min(distance / ceiling, 1);
  return `${Math.round(ratio * PERCENT)} %`;
}
