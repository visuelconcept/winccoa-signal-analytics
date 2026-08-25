// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The live watch: how strange the last few minutes look, right now.
 *
 * The score is the same quantity the historical analysis produced — the distance
 * from the newest window to the closest thing the analysed history contains — so
 * the threshold learnt offline is directly the line drawn here. That is what
 * makes the sparkline readable at a glance: below the dashed line the process is
 * doing something it has done before.
 *
 * The sparkline is an inline SVG rather than a second echarts instance. It shows
 * at most a couple of hundred throttled scores, it never needs a tooltip or a
 * zoom, and a chart library per signal tile would cost far more than it returns.
 *
 * The panel states are distinct on purpose, because they mean different things
 * to whoever is looking: switched off (a decision), not armed (waiting for a
 * first analysis), armed and quiet, armed and above the line.
 */
import { IXCoreStyles } from '@wincc-oa/wui-shared/styles/ix-core.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MSG, localizeDir } from '../i18n.js';
import type { LiveState } from '../types.js';
import {
  dateTime,
  duration,
  isoDateTime,
  score,
  severity,
  timeOfDay
} from './format.js';

const SPARK_WIDTH = 320;
const SPARK_HEIGHT = 56;
/** Head-room above the highest plotted value so a peak is not clipped. */
const SPARK_HEADROOM = 1.15;

@customElement('sa-live')
export class SaLive extends LitElement {
  static override readonly styles = [IXCoreStyles, liveStyles()];

  @property({ attribute: false }) live: LiveState | null = null;

  /** False when the signal's configuration switches live watching off. */
  @property({ type: Boolean }) enabled = true;

  override render(): TemplateResult {
    if (!this.enabled) {
      return html`<p class="muted">${localizeDir(MSG.detail.realtimeOff)}</p>`;
    }
    if (!this.live?.armed) {
      return html`<p class="muted">${localizeDir(MSG.detail.notArmed)}</p>`;
    }

    const live = this.live;
    const alarming = live.anomaly === true;
    return html`
      <div class="head ${alarming ? 'alarming' : ''}">
        <div class="metric">
          <span class="label">${localizeDir(MSG.detail.score)}</span>
          <span class="value">${score(live.score)}</span>
        </div>
        <div class="metric">
          <span class="label">${localizeDir(MSG.detail.threshold)}</span>
          <span class="value muted">${score(live.threshold)}</span>
        </div>
        <div class="metric">
          <span class="label">${localizeDir(MSG.detail.severity)}</span>
          <span class="value">${severity(live.severity)}</span>
        </div>
        <div class="stamp muted">${isoDateTime(live.updatedAt)}</div>
      </div>
      ${this.sparkline(live)} ${this.events(live)}
    `;
  }

  /**
   * The recent scores against the threshold.
   *
   * The vertical scale spans zero to whichever is larger — the highest score or
   * the threshold — so the line stays on screen when the process is calm *and*
   * the threshold stays visible when it is not.
   */
  private sparkline(live: LiveState): TemplateResult {
    const scores = live.recent ?? [];
    if (scores.length < 2) return html`<div class="spark-empty"></div>`;

    const threshold = live.threshold ?? 0;
    const peak =
      Math.max(threshold, ...scores.map((point) => point.s)) * SPARK_HEADROOM ||
      1;
    const first = scores[0].t;
    const last = scores.at(-1)?.t ?? first + 1;
    const span = Math.max(last - first, 1);

    const x = (time: number): number => ((time - first) / span) * SPARK_WIDTH;
    const y = (value: number): number =>
      SPARK_HEIGHT - (value / peak) * SPARK_HEIGHT;

    const path = scores
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.s).toFixed(1)}`
      )
      .join(' ');
    const thresholdY = y(threshold).toFixed(1);

    return html`
      <svg
        class="spark"
        viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}"
        preserveAspectRatio="none"
        role="img"
        aria-label="${scores.length} scores"
      >
        <line
          x1="0"
          y1=${thresholdY}
          x2=${SPARK_WIDTH}
          y2=${thresholdY}
          class="threshold-line"
        ></line>
        <path d=${path} class="score-line"></path>
      </svg>
      <div class="spark-axis muted">
        <span>${timeOfDay(first)}</span>
        <span>${timeOfDay(last)}</span>
      </div>
    `;
  }

  private events(live: LiveState): TemplateResult {
    const events = live.events ?? [];
    return html`
      <div class="events">
        <div class="events-title">${localizeDir(MSG.detail.liveEvents)}</div>
        ${
          events.length === 0
            ? html`<p class="muted small">
                ${localizeDir(MSG.detail.noLiveEvent)}
              </p>`
            : html`<ul>
                ${[...events].reverse().map(
                  (event) => html`
                    <li>
                      <span class="dot"></span>
                      <span>${dateTime(event.start)}</span>
                      <span class="muted"
                        >${duration(Math.max(event.end - event.start, 0))}</span
                      >
                      <span class="score">${score(event.score)}</span>
                    </li>
                  `
                )}
              </ul>`
        }
      </div>
      ${
        live.bufferPoints
          ? html`<p class="muted small">
              ${live.bufferPoints} pts · ${localizeDir(MSG.detail.sampleStep)}
              ${duration(live.stepMs ?? 0)}
            </p>`
          : nothing
      }
    `;
  }
}

// eslint-disable-next-line max-lines-per-function -- single stylesheet literal
function liveStyles(): ReturnType<typeof css> {
  return css`
    :host {
      display: block;
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: 1.25rem;
      flex-wrap: wrap;
      padding: 0.35rem 0.5rem;
      border-radius: var(--theme-default-border-radius);
    }
    .head.alarming {
      background: color-mix(in srgb, #e8663c 18%, transparent);
    }
    .metric {
      display: flex;
      flex-direction: column;
    }
    .label {
      font-size: 0.75rem;
      color: var(--theme-color-soft-text);
    }
    .value {
      font-size: 1.1rem;
      font-variant-numeric: tabular-nums;
    }
    .stamp {
      margin-left: auto;
      font-size: 0.78rem;
    }
    .spark,
    .spark-empty {
      width: 100%;
      height: 56px;
      margin-top: 0.5rem;
    }
    .score-line {
      fill: none;
      stroke: #3ba1e0;
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
    .threshold-line {
      stroke: #c0392b;
      stroke-width: 1;
      stroke-dasharray: 4 3;
      vector-effect: non-scaling-stroke;
    }
    .spark-axis {
      display: flex;
      justify-content: space-between;
      font-size: 0.72rem;
    }
    .events {
      margin-top: 0.75rem;
    }
    .events-title {
      font-weight: 600;
      margin-bottom: 0.25rem;
    }
    .events ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      max-height: 140px;
      overflow-y: auto;
    }
    .events li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #e8663c;
      flex: none;
    }
    .score {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }
    .muted {
      color: var(--theme-color-soft-text);
    }
    .small {
      font-size: 0.8rem;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'sa-live': SaLive;
  }
}
