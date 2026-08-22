// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two finding lists: what never happened again, and what keeps happening.
 *
 * They sit side by side on purpose. Both are readings of the same computation,
 * and an operator's first question about an anomaly is almost always "compared
 * to what?" — the recurrence list is the answer, in the same panel.
 *
 * Readability decisions, each earning its ink:
 *
 * - anomaly rows lead with their **rank number in a badge** — the same number
 *   the chart prints inside the band, so row ↔ band matching is a glance, not a
 *   hunt;
 * - the severity is a **coloured chip** (amber below ×2, red from ×2 up): a list
 *   of near-identical rows must let the eye find the worst one first;
 * - a joint analysis names the **leading signal** of each anomaly ("porté par
 *   power 61 %"), in that signal's own curve colour;
 * - the lists obey the page's {@link DisplayFilter} — the same object the chart
 *   draws by — and a severity floor says how many rows it hid rather than
 *   letting them vanish silently.
 *
 * Each row is selectable and emits `wui:select`, which the page forwards to the
 * chart so the matching bands light up. Selecting the same row again clears it,
 * so a click is never a one-way trip.
 */
import { IXCoreStyles } from '@wincc-oa/wui-shared/styles/ix-core.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MSG, localizeDir } from '../i18n.js';
import type { AnalysisResult, Anomaly, Recurrence } from '../types.js';
import {
  defaultDisplayFilter,
  passesFilter,
  type DisplayFilter
} from './display-filter.js';
import { closeness, duration, score, severity, timeOfDay } from './format.js';
import { elementColor, shortName, type FindingRef } from './sa-chart.js';

/** A severity chip turns red from this multiple of the threshold. */
const SEVERE_FROM = 2;

@customElement('sa-findings')
export class SaFindings extends LitElement {
  static override readonly styles = [IXCoreStyles, findingStyles()];

  @property({ attribute: false }) result: AnalysisResult | null = null;
  @property({ attribute: false }) selected: FindingRef = null;

  /** What to list — owned by the page, shared with the chart. */
  @property({ attribute: false }) filter: DisplayFilter =
    defaultDisplayFilter();

  override render(): TemplateResult {
    if (!this.result) {
      return html`<div class="empty">
        ${localizeDir(MSG.detail.notAnalysed)}
      </div>`;
    }
    const visible = this.result.anomalies.filter((anomaly) =>
      passesFilter(anomaly, this.filter)
    );
    const hidden = this.filter.anomalies
      ? this.result.anomalies.length - visible.length
      : 0;
    return html`
      <div class="columns">
        ${
          this.filter.anomalies
            ? html`<section>
                <header>
                  <ix-icon name="warning" size="16" class="anomaly"></ix-icon>
                  <span>${localizeDir(MSG.list.anomalies)}</span>
                  <span class="count"
                    >${visible.length}${hidden > 0 ? ` / ${this.result.anomalies.length}` : ''}</span
                  >
                </header>
                ${
                  visible.length === 0
                    ? html`<p class="empty">
                        ${
                          hidden > 0
                            ? html`${hidden}
                              ${localizeDir(MSG.filters.filtered)}`
                            : localizeDir(MSG.detail.noAnomaly)
                        }
                      </p>`
                    : html`<ul>
                          ${visible.map((anomaly) => this.anomalyRow(anomaly))}
                        </ul>
                        ${
                          hidden > 0
                            ? html`<p class="muted small">
                                +${hidden} ${localizeDir(MSG.filters.filtered)}
                              </p>`
                            : nothing
                        }`
                }
              </section>`
            : nothing
        }
        ${
          this.filter.recurrences
            ? html`<section>
                <header>
                  <ix-icon
                    name="refresh"
                    size="16"
                    class="recurrence"
                  ></ix-icon>
                  <span>${localizeDir(MSG.list.recurrences)}</span>
                  <span class="count">${this.result.recurrences.length}</span>
                </header>
                ${
                  this.result.recurrences.length === 0
                    ? html`<p class="empty">
                        ${localizeDir(MSG.detail.noRecurrence)}
                      </p>`
                    : html`<ul>
                        ${this.result.recurrences.map((recurrence) => this.recurrenceRow(recurrence))}
                      </ul>`
                }
              </section>`
            : nothing
        }
      </div>
    `;
  }

  private anomalyRow(anomaly: Anomaly): TemplateResult {
    const id = String(anomaly.rank);
    const active = this.selected?.kind === 'anomaly' && this.selected.id === id;
    const severe = (anomaly.severity ?? 0) >= SEVERE_FROM;
    return html`
      <li
        class="row ${active ? 'active' : ''}"
        tabindex="0"
        role="button"
        @click=${() => this.select('anomaly', id)}
        @keydown=${(event: KeyboardEvent) => this.onKey(event, 'anomaly', id)}
      >
        <span class="rank anomaly-rank">${anomaly.rank}</span>
        <div class="body">
          <div class="line">
            <strong>${timeOfDay(anomaly.start)}</strong>
            <span class="muted">${duration(anomaly.end - anomaly.start)}</span>
            <span class="chip ${severe ? 'severe' : 'notable'}"
              >${severity(anomaly.severity)}</span
            >
          </div>
          <div class="line muted small">
            ${localizeDir(MSG.detail.score)} ${score(anomaly.score)}
            ${this.contribution(anomaly)}
          </div>
        </div>
      </li>
    `;
  }

  /** "porté par power 61 %", coloured like that element's curve. */
  private contribution(anomaly: Anomaly): TemplateResult | typeof nothing {
    const contributions = anomaly.contributions;
    if (!contributions) return nothing;
    const entries = Object.entries(contributions).sort((a, b) => b[1] - a[1]);
    const lead = entries[0];
    if (!lead) return nothing;
    const index = Object.keys(contributions).indexOf(lead[0]);
    return html`
      · ${localizeDir(MSG.detail.drivenBy)}
      <span class="lead" style="color: ${elementColor(Math.max(index, 0))}"
        >${shortName(lead[0])} ${Math.round(lead[1] * 100)} %</span
      >
    `;
  }

  private recurrenceRow(recurrence: Recurrence): TemplateResult {
    const active =
      this.selected?.kind === 'recurrence' &&
      this.selected.id === recurrence.id;
    const window = this.result?.window ?? 1;
    return html`
      <li
        class="row ${active ? 'active' : ''}"
        tabindex="0"
        role="button"
        @click=${() => this.select('recurrence', recurrence.id)}
        @keydown=${(event: KeyboardEvent) => this.onKey(event, 'recurrence', recurrence.id)}
      >
        <span class="rank recurrence-rank">${recurrence.rank}</span>
        <div class="body">
          <div class="line">
            <strong
              >${recurrence.count}
              ${localizeDir(MSG.detail.occurrences)}</strong
            >
            ${
              recurrence.periodMs
                ? html`<span class="muted"
                    >${localizeDir(MSG.detail.period)}
                    ${duration(recurrence.periodMs)}</span
                  >`
                : nothing
            }
            <span class="chip match"
              >${closeness(recurrence.distance, window)}</span
            >
          </div>
          <div class="line muted small">
            ${timeOfDay(recurrence.occurrences[0]?.start ?? 0)} →
            ${timeOfDay(recurrence.occurrences.at(-1)?.end ?? 0)}
          </div>
        </div>
      </li>
    `;
  }

  private onKey(
    event: KeyboardEvent,
    kind: 'anomaly' | 'recurrence',
    id: string
  ): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.select(kind, id);
  }

  private select(kind: 'anomaly' | 'recurrence', id: string): void {
    const same = this.selected?.kind === kind && this.selected.id === id;
    this.dispatchEvent(
      new CustomEvent<FindingRef>('wui:select', {
        detail: same ? null : { kind, id },
        bubbles: true,
        composed: true
      })
    );
  }
}

// eslint-disable-next-line max-lines-per-function -- single stylesheet literal
function findingStyles(): ReturnType<typeof css> {
  return css`
    :host {
      display: block;
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1rem;
    }
    header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding-bottom: 0.4rem;
      border-bottom: 1px solid var(--theme-color-soft-bdr);
      margin-bottom: 0.5rem;
      font-weight: 600;
    }
    .count {
      margin-left: auto;
      color: var(--theme-color-soft-text);
      font-variant-numeric: tabular-nums;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      max-height: 280px;
      overflow-y: auto;
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      padding: 0.4rem 0.5rem;
      border-radius: var(--theme-default-border-radius);
      border: 1px solid transparent;
      cursor: pointer;
    }
    .row:hover,
    .row:focus-visible {
      background: var(--theme-color-3);
      outline: none;
    }
    .row.active {
      background: var(--theme-color-3);
      border-color: var(--theme-color-primary);
    }
    .rank {
      flex: none;
      min-width: 1.4rem;
      height: 1.4rem;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 700;
      margin-top: 0.1rem;
    }
    .anomaly-rank {
      background: color-mix(in srgb, #e8663c 22%, transparent);
      color: #e8663c;
    }
    .recurrence-rank {
      background: color-mix(in srgb, #41b883 22%, transparent);
      color: #41b883;
    }
    .body {
      flex: 1;
      min-width: 0;
    }
    .line {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .chip {
      margin-left: auto;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.05rem 0.45rem;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .chip.notable {
      background: color-mix(in srgb, #e0a458 20%, transparent);
      color: #e0a458;
    }
    .chip.severe {
      background: color-mix(in srgb, #e8663c 24%, transparent);
      color: #e8663c;
    }
    .chip.match {
      background: color-mix(in srgb, #41b883 18%, transparent);
      color: #41b883;
    }
    .lead {
      font-weight: 600;
    }
    ix-icon.anomaly {
      color: #e8663c;
    }
    ix-icon.recurrence {
      color: #41b883;
    }
    .muted {
      color: var(--theme-color-soft-text);
    }
    .small {
      font-size: 0.82rem;
    }
    .empty {
      color: var(--theme-color-soft-text);
      font-style: italic;
      margin: 0.5rem 0;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'sa-findings': SaFindings;
  }
}
