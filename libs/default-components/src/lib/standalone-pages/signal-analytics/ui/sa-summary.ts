// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The analysis card: what was analysed, with which parameters, when.
 *
 * This exists because a result without its frame misleads. Clicking "Analyse"
 * twice in a row produces two results whose findings can differ — the period
 * ends *now*, and now moved — and without the period printed in full, the
 * second result reads as a contradiction of the first instead of as a different
 * question. So the card leads with the **analysed period** (both ends, dated,
 * plus its length) and the **computed-at** instant, and the whole card flashes
 * when a new result lands so the replacement is seen, not deduced.
 *
 * It also compares the result against the CURRENT configuration: parameters
 * edited after the run (another window, another engine, another element list)
 * make the card say so — the one state where trusting the screen is wrong.
 */
import { IXCoreStyles } from '@wincc-oa/wui-shared/styles/ix-core.js';
import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MSG, engineLabel, localizeDir, windowMsg } from '../i18n.js';
import type { AnalysisResult, SignalConfig, SignalStatus } from '../types.js';
import { dateTime, duration, isoDateTime, score } from './format.js';
import { elementColor, shortName } from './sa-chart.js';

/** How long the new-result flash stays on (ms). */
const FLASH_MS = 2500;

@customElement('sa-summary')
export class SaSummary extends LitElement {
  static override readonly styles = [IXCoreStyles, summaryStyles()];

  @property({ attribute: false }) result: AnalysisResult | null = null;
  @property({ attribute: false }) status: SignalStatus | null = null;
  @property({ attribute: false }) config: SignalConfig | null = null;

  @state() private flash = false;

  private flashTimer = 0;
  private seenRequest = '';

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this.flashTimer);
  }

  override render(): TemplateResult | typeof nothing {
    const result = this.result;
    if (!result) return nothing;
    return html`
      <div class="card ${this.flash ? 'flash' : ''}">
        <div class="head">
          <span class="title">${localizeDir(MSG.summary.title)}</span>
          <span class="muted">
            ${localizeDir(MSG.summary.computed)}
            ${isoDateTime(result.computedAt)} ${localizeDir(MSG.summary.took)}
            ${duration(result.durationMs)}
          </span>
        </div>
        <div class="period">
          <span class="label">${localizeDir(MSG.summary.period)}</span>
          <strong>${dateTime(result.from)}</strong>
          <span class="arrow">→</span>
          <strong>${dateTime(result.to)}</strong>
          <span class="chip">${duration(result.to - result.from)}</span>
        </div>
        <div class="facts">
          ${this.fact(MSG.summary.engine, localizeDir(engineLabel(result.engine)))}
          ${this.fact(MSG.summary.window, this.windowText(result))}
          ${this.fact(MSG.summary.points, `${result.sampleCount}`)}
          ${this.fact(MSG.summary.threshold, score(result.threshold))}
        </div>
        ${this.elements(result)} ${this.staleWarning(result)}
      </div>
    `;
  }

  protected override updated(_changed: PropertyValues): void {
    const requestId = this.result
      ? `${this.result.requestId}|${this.result.computedAt}`
      : '';
    if (requestId === this.seenRequest) return;
    const isFirst = this.seenRequest === '';
    this.seenRequest = requestId;
    // The first paint is not a "new result arrived" — only a replacement is.
    if (isFirst || requestId === '') return;
    this.flash = true;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => (this.flash = false), FLASH_MS);
  }

  private fact(
    label: (typeof MSG.summary)['engine'],
    value: unknown
  ): TemplateResult {
    return html`<span class="fact"
      ><span class="label">${localizeDir(label)}</span
      ><span class="value">${value}</span></span
    >`;
  }

  private windowText(result: AnalysisResult): TemplateResult {
    const stepMs = this.status?.stepMs ?? 0;
    if (stepMs <= 0) return html`${result.window}`;
    return html`${localizeDir(windowMsg(result.window, duration(result.window * stepMs)))}`;
  }

  /** The analysed elements in their curve colours — the chart's legend, restated. */
  private elements(result: AnalysisResult): TemplateResult | typeof nothing {
    const dpes = result.dpes ?? (result.dpe ? [result.dpe] : []);
    if (dpes.length < 2) return nothing;
    return html`
      <div class="elements">
        <span class="label">${localizeDir(MSG.summary.elements)}</span>
        ${dpes.map(
          (dpe, index) => html`
            <span class="element" style="color: ${elementColor(index)}">
              <span
                class="swatch"
                style="background: ${elementColor(index)}"
              ></span>
              ${shortName(dpe)}
            </span>
          `
        )}
      </div>
    `;
  }

  /**
   * The result no longer describes the configuration.
   *
   * Compared on what actually changes an analysis — the elements, the window,
   * the engine. Cosmetic edits (the label, the live-watch throttle) must not
   * cry wolf, or the warning trains itself into being ignored.
   */
  private staleWarning(
    result: AnalysisResult
  ): TemplateResult | typeof nothing {
    const config = this.config;
    if (!config) return nothing;
    const resultDpes = result.dpes ?? (result.dpe ? [result.dpe] : []);
    const stale =
      config.window !== result.window ||
      config.engine !== result.engine ||
      config.dpes.join('|') !== resultDpes.join('|');
    if (!stale) return nothing;
    return html`<div class="stale">
      <ix-icon name="warning" size="16"></ix-icon
      >${localizeDir(MSG.summary.staleParams)}
    </div>`;
  }
}

// eslint-disable-next-line max-lines-per-function -- single stylesheet literal
function summaryStyles(): ReturnType<typeof css> {
  return css`
    :host {
      display: block;
    }
    .card {
      border: 1px solid var(--theme-color-soft-bdr);
      border-radius: var(--theme-default-border-radius);
      background: var(--theme-color-2);
      padding: 0.6rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      transition:
        border-color 0.4s ease,
        box-shadow 0.4s ease;
    }
    .card.flash {
      border-color: var(--theme-color-primary);
      box-shadow: 0 0 0 1px var(--theme-color-primary);
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .title {
      font-weight: 600;
    }
    .head .muted {
      margin-left: auto;
      font-size: 0.8rem;
    }
    .period {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      flex-wrap: wrap;
      font-size: 1rem;
    }
    .arrow {
      color: var(--theme-color-soft-text);
    }
    .chip {
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.05rem 0.45rem;
      border-radius: 999px;
      background: color-mix(
        in srgb,
        var(--theme-color-primary) 18%,
        transparent
      );
      color: var(--theme-color-primary);
      white-space: nowrap;
    }
    .facts {
      display: flex;
      gap: 1.25rem;
      flex-wrap: wrap;
    }
    .fact {
      display: inline-flex;
      flex-direction: column;
      gap: 0.05rem;
    }
    .label {
      font-size: 0.72rem;
      color: var(--theme-color-soft-text);
    }
    .value {
      font-variant-numeric: tabular-nums;
    }
    .elements {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .element {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .swatch {
      width: 14px;
      height: 3px;
      border-radius: 2px;
      display: inline-block;
    }
    .stale {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: #e0a458;
      font-size: 0.85rem;
    }
    .muted {
      color: var(--theme-color-soft-text);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'sa-summary': SaSummary;
  }
}
