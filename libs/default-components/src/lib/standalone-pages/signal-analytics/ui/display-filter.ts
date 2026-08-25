// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The display filter: what the chart and the finding lists agree to show.
 *
 * One object, owned by the page, passed to both — so hiding the recurrences on
 * the chart also collapses their list, and a severity floor thins the anomaly
 * bands *and* the anomaly rows in the same click. Two views disagreeing about
 * what is visible is precisely the confusion a filter exists to remove.
 *
 * It is view state, deliberately transient: it filters what is LOOKED AT, never
 * what was FOUND — the result on the datapoint is untouched, and a reload shows
 * everything again.
 */
import type { Anomaly } from '../types.js';

export interface DisplayFilter {
  /** Show the anomaly bands and rows. */
  anomalies: boolean;
  /** Show the recurrence bands and rows. */
  recurrences: boolean;
  /** Show the manager's score curve and threshold line under the signal. */
  band: boolean;
  /**
   * Hide anomalies whose severity (score ÷ threshold) is below this.
   * 0 shows everything; an anomaly without a severity is never hidden —
   * "unknown" must not silently mean "unimportant".
   */
  minSeverity: number;
}

export function defaultDisplayFilter(): DisplayFilter {
  return { anomalies: true, recurrences: true, band: true, minSeverity: 0 };
}

/** The severity floors the toolbar offers. */
export const SEVERITY_STEPS = [0, 1.5, 2, 3] as const;

/** Does this anomaly survive the filter? */
export function passesFilter(anomaly: Anomaly, filter: DisplayFilter): boolean {
  if (!filter.anomalies) return false;
  if (filter.minSeverity <= 0) return true;
  return anomaly.severity == null || anomaly.severity >= filter.minSeverity;
}
