// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Configure one analysed signal: what to watch, with which engine, how finely.
 *
 * A signal names one OR SEVERAL datapoint elements. Several elements mean ONE
 * joint analysis (mSTAMP) — not N separate ones — so the form presents them as
 * one ordered list with add/remove, and its hint says what "joint" buys: the
 * anomalies that only exist in the correlation between signals.
 *
 * Two more things shape this form.
 *
 * **The engine choice is explained where it is made.** `numpy`, `stumpy` and
 * `chronos` are not three speeds of the same thing — the first two answer "has
 * this shape occurred before?", the third "was this predictable?" — and two of
 * them may not be installed on the server. So each option carries its sentence,
 * and an engine the manager has reported as unavailable is shown as such instead
 * of silently falling back after the user has waited for an analysis.
 *
 * **The window is shown as a duration.** It is configured in samples, because
 * that is what the arithmetic uses, but nobody thinks in samples. The sample
 * step the manager reported for the last run turns it into "≈ 3 min 12 s", which
 * is the number that tells an operator whether they are looking for a valve
 * stroke or a shift pattern.
 *
 * Emits `wui:apply` with the edited configuration, `wui:cancel` otherwise. The
 * dialog never writes anything itself — the page owns persistence.
 */
import './sa-dp-input.js';
import { dialogCore } from './dialog-styles.js';
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
import { MSG, engineLabel, localize, localizeDir, windowMsg } from '../i18n.js';
import {
  ENGINE_IDS,
  blankSignal,
  type EngineAvailability,
  type EngineId,
  type SignalConfig
} from '../types.js';
import { duration } from './format.js';
import { elementColor } from './sa-chart.js';

/** Mirror of the manager's MAX_DIMENSIONS — the O(n²) work scales with each one. */
const MAX_ELEMENTS = 8;

interface IxValueEvent {
  detail: string | string[];
}

/**
 * What `wui-dp-input` emits — an object, not the bare string.
 *
 * The kit component dispatches `wui:change` with `detail: { value }`. Treating
 * that detail as the value itself is silent: it type-checks against a
 * `CustomEvent<string>` annotation, and the field then shows `[object Object]`.
 */
type DpChangeEvent = CustomEvent<{ value: string }>;

/** `ix-select` reports `string | string[]`; a single-select still needs one value. */
function selectedValue(detail: string | string[]): string {
  return Array.isArray(detail) ? (detail[0] ?? '') : detail;
}

function numberOf(detail: string | string[], fallback: number): number {
  const parsed = Number(selectedValue(detail));
  return Number.isFinite(parsed) ? parsed : fallback;
}

@customElement('sa-signal-dialog')
export class SaSignalDialog extends LitElement {
  static override readonly styles = [IXCoreStyles, dialogStyles()];

  /** Signal to edit; `null` creates a new one. */
  @property({ attribute: false }) signal: SignalConfig | null = null;

  /** What the manager last reported about engine availability, if anything. */
  @property({ attribute: false }) engines: Record<
    string,
    EngineAvailability
  > | null = null;

  /** Sample step of the last analysis (ms) — turns the window into a duration. */
  @property({ type: Number }) stepMs = 0;

  @state() private working: SignalConfig = blankSignal();

  override render(): TemplateResult {
    const isNew = this.signal === null;
    const error = this.validate();
    return html`
      <div class="overlay" @click=${this.cancel}>
        <div class="panel" @click=${(event: Event) => event.stopPropagation()}>
          <div class="panel-head">
            <ix-typography format="h3">
              ${localizeDir(isNew ? MSG.form.createTitle : MSG.form.editTitle)}
            </ix-typography>
            <ix-icon-button
              ghost
              icon="close"
              @click=${this.cancel}
            ></ix-icon-button>
          </div>
          <div class="panel-body">
            ${this.renderIdentity()} ${this.renderEngine()}
            ${this.renderDetection()} ${this.renderRealtime()}
            ${this.working.engine === 'chronos' ? this.renderChronos() : nothing}
            ${
              error === ''
                ? nothing
                : html`<div class="error">
                    <ix-icon name="warning" size="16"></ix-icon>${error}
                  </div>`
            }
          </div>
          <div class="panel-foot">
            <ix-button variant="secondary" @click=${this.cancel}
              >${localizeDir(MSG.actions.cancel)}</ix-button
            >
            <ix-button ?disabled=${error !== ''} @click=${this.apply}>
              ${localizeDir(isNew ? MSG.actions.create : MSG.actions.save)}
            </ix-button>
          </div>
        </div>
      </div>
    `;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('signal')) {
      this.working = this.signal ? structuredClone(this.signal) : blankSignal();
    }
  }

  private renderIdentity(): TemplateResult {
    return html`
      <ix-input
        label=${localize(MSG.form.label)}
        .value=${this.working.label}
        @valueChange=${(event: IxValueEvent) => this.patch({ label: selectedValue(event.detail) })}
      ></ix-input>
      <div class="group-title">${localize(MSG.form.dpe)}</div>
      ${this.working.dpes.map(
        (dpe, index) => html`
          <div class="dpe-row">
            <span
              class="swatch"
              style="background: ${elementColor(index)}"
            ></span>
            <wui-dp-input
              class="dpe-input"
              .value=${dpe}
              @wui:change=${(event: DpChangeEvent) => this.patchDpe(index, event.detail.value)}
            ></wui-dp-input>
            ${
              this.working.dpes.length > 1
                ? html`<ix-icon-button
                    ghost
                    icon="close"
                    title=${localize(MSG.form.removeElement)}
                    @click=${() => this.removeDpe(index)}
                  ></ix-icon-button>`
                : nothing
            }
          </div>
        `
      )}
      <ix-button
        variant="secondary"
        ?disabled=${this.working.dpes.length >= MAX_ELEMENTS}
        @click=${this.addDpe}
      >
        <ix-icon name="plus" slot="icon"></ix-icon
        >${localizeDir(MSG.form.addElement)}
      </ix-button>
      <p class="hint">${localizeDir(MSG.form.dpeHint)}</p>
      <ix-toggle
        ?checked=${this.working.enabled}
        @checkedChange=${(event: CustomEvent<boolean>) => this.patch({ enabled: event.detail })}
        >${localizeDir(MSG.form.enabled)}</ix-toggle
      >
    `;
  }

  private renderEngine(): TemplateResult {
    return html`
      <div class="group-title">${localizeDir(MSG.engine.label)}</div>
      <ix-select
        .value=${this.working.engine}
        @valueChange=${(event: IxValueEvent) =>
          this.patch({ engine: selectedValue(event.detail) as EngineId })}
      >
        ${ENGINE_IDS.map(
          (id) =>
            html`<ix-select-item
              value=${id}
              label=${this.engineOptionLabel(id)}
            ></ix-select-item>`
        )}
      </ix-select>
      <p class="hint">${localizeDir(this.engineHint())}</p>
    `;
  }

  /** "Chronos (forecasting) — not installed on the server", when the manager said so. */
  private engineOptionLabel(id: EngineId): string {
    const label = localize(engineLabel(id));
    const availability = this.engines?.[id];
    if (availability && !availability.available) {
      return `${label} — ${localize(MSG.engine.unavailable)}`;
    }
    return label;
  }

  private engineHint(): (typeof MSG.engine)['numpyHint'] {
    if (this.working.engine === 'stumpy') return MSG.engine.stumpyHint;
    if (this.working.engine === 'chronos') return MSG.engine.chronosHint;
    return MSG.engine.numpyHint;
  }

  private renderDetection(): TemplateResult {
    return html`
      <div class="group-title">${localizeDir(MSG.form.advanced)}</div>
      <div class="grid">
        <div class="field">
          <ix-number-input
            label=${localize(MSG.form.window)}
            .value=${this.working.window}
            min="4"
            max="5000"
            @valueChange=${(event: IxValueEvent) =>
              this.patch({
                window: numberOf(event.detail, this.working.window)
              })}
          ></ix-number-input>
          <p class="hint">${this.windowHint()}</p>
        </div>
        <ix-number-input
          label=${localize(MSG.form.historyHours)}
          .value=${this.working.history.hours}
          min="0.1"
          max="2160"
          @valueChange=${(event: IxValueEvent) =>
            this.patchHistory({
              hours: numberOf(event.detail, this.working.history.hours)
            })}
        ></ix-number-input>
        <div class="field">
          <ix-number-input
            label=${localize(MSG.form.maxPoints)}
            .value=${this.working.history.maxPoints}
            min="200"
            max="200000"
            @valueChange=${(event: IxValueEvent) =>
              this.patchHistory({
                maxPoints: numberOf(
                  event.detail,
                  this.working.history.maxPoints
                )
              })}
          ></ix-number-input>
          <p class="hint">${localizeDir(MSG.form.maxPointsHint)}</p>
        </div>
        <ix-number-input
          label=${localize(MSG.form.maxAnomalies)}
          .value=${this.working.anomalies.max}
          min="1"
          max="200"
          @valueChange=${(event: IxValueEvent) =>
            this.patchAnomalies({
              max: numberOf(event.detail, this.working.anomalies.max)
            })}
        ></ix-number-input>
        <div class="field">
          <ix-number-input
            label=${localize(MSG.form.sensitivity)}
            .value=${this.working.anomalies.sensitivity}
            min="0.5"
            max="20"
            step="0.5"
            @valueChange=${(event: IxValueEvent) =>
              this.patchAnomalies({
                sensitivity: numberOf(
                  event.detail,
                  this.working.anomalies.sensitivity
                )
              })}
          ></ix-number-input>
          <p class="hint">${localizeDir(MSG.form.sensitivityHint)}</p>
        </div>
        <ix-number-input
          label=${localize(MSG.form.maxRecurrences)}
          .value=${this.working.recurrences.max}
          min="1"
          max="50"
          @valueChange=${(event: IxValueEvent) =>
            this.patchRecurrences({
              max: numberOf(event.detail, this.working.recurrences.max)
            })}
        ></ix-number-input>
        <div class="field">
          <ix-number-input
            label=${localize(MSG.form.radius)}
            .value=${this.working.recurrences.radius}
            min="1"
            max="20"
            step="0.5"
            @valueChange=${(event: IxValueEvent) =>
              this.patchRecurrences({
                radius: numberOf(event.detail, this.working.recurrences.radius)
              })}
          ></ix-number-input>
          <p class="hint">${localizeDir(MSG.form.radiusHint)}</p>
        </div>
      </div>
    `;
  }

  /** The window as a duration, once an analysis has established the sample step. */
  private windowHint(): TemplateResult {
    if (this.stepMs <= 0) return html`${localizeDir(MSG.form.windowHint)}`;
    return html`${localizeDir(windowMsg(this.working.window, duration(this.working.window * this.stepMs)))}`;
  }

  private renderRealtime(): TemplateResult {
    return html`
      <div class="group-title">${localizeDir(MSG.detail.liveTitle)}</div>
      <ix-toggle
        ?checked=${this.working.realtime.enabled}
        @checkedChange=${(event: CustomEvent<boolean>) => this.patchRealtime({ enabled: event.detail })}
        >${localizeDir(MSG.form.realtime)}</ix-toggle
      >
      <p class="hint">${localizeDir(MSG.form.realtimeHint)}</p>
      ${
        this.working.realtime.enabled
          ? html`<div class="grid">
              <ix-number-input
                label=${localize(MSG.form.throttle)}
                .value=${this.working.realtime.throttleMs}
                min="250"
                max="600000"
                @valueChange=${(event: IxValueEvent) =>
                  this.patchRealtime({
                    throttleMs: numberOf(
                      event.detail,
                      this.working.realtime.throttleMs
                    )
                  })}
              ></ix-number-input>
              <ix-number-input
                label=${localize(MSG.form.bufferPoints)}
                .value=${this.working.realtime.bufferPoints}
                min="50"
                max="100000"
                @valueChange=${(event: IxValueEvent) =>
                  this.patchRealtime({
                    bufferPoints: numberOf(
                      event.detail,
                      this.working.realtime.bufferPoints
                    )
                  })}
              ></ix-number-input>
            </div>`
          : nothing
      }
    `;
  }

  private renderChronos(): TemplateResult {
    return html`
      <div class="group-title">${localizeDir(MSG.form.chronosSection)}</div>
      <ix-input
        label=${localize(MSG.form.chronosModel)}
        .value=${this.working.chronos.model}
        @valueChange=${(event: IxValueEvent) =>
          this.patchChronos({ model: selectedValue(event.detail) })}
      ></ix-input>
      <div class="grid">
        <ix-number-input
          label=${localize(MSG.form.chronosContext)}
          .value=${this.working.chronos.context}
          min="32"
          max="8192"
          @valueChange=${(event: IxValueEvent) =>
            this.patchChronos({
              context: numberOf(event.detail, this.working.chronos.context)
            })}
        ></ix-number-input>
        <ix-number-input
          label=${localize(MSG.form.chronosHorizon)}
          .value=${this.working.chronos.horizon}
          min="4"
          max="512"
          @valueChange=${(event: IxValueEvent) =>
            this.patchChronos({
              horizon: numberOf(event.detail, this.working.chronos.horizon)
            })}
        ></ix-number-input>
      </div>
    `;
  }

  private validate(): string {
    if (this.working.label.trim() === '')
      return localize(MSG.form.labelRequired);
    if (!this.working.dpes.some((dpe) => dpe.trim() !== ''))
      return localize(MSG.form.dpeRequired);
    return '';
  }

  private patchDpe(index: number, value: string): void {
    const dpes = [...this.working.dpes];
    dpes[index] = value;
    this.patch({ dpes });
  }

  private addDpe(): void {
    if (this.working.dpes.length >= MAX_ELEMENTS) return;
    this.patch({ dpes: [...this.working.dpes, ''] });
  }

  private removeDpe(index: number): void {
    const dpes = this.working.dpes.filter((_dpe, at) => at !== index);
    this.patch({ dpes: dpes.length > 0 ? dpes : [''] });
  }

  private patch(patch: Partial<SignalConfig>): void {
    this.working = { ...this.working, ...patch };
  }

  private patchHistory(patch: Partial<SignalConfig['history']>): void {
    this.working = {
      ...this.working,
      history: { ...this.working.history, ...patch }
    };
  }

  private patchAnomalies(patch: Partial<SignalConfig['anomalies']>): void {
    this.working = {
      ...this.working,
      anomalies: { ...this.working.anomalies, ...patch }
    };
  }

  private patchRecurrences(patch: Partial<SignalConfig['recurrences']>): void {
    this.working = {
      ...this.working,
      recurrences: { ...this.working.recurrences, ...patch }
    };
  }

  private patchRealtime(patch: Partial<SignalConfig['realtime']>): void {
    this.working = {
      ...this.working,
      realtime: { ...this.working.realtime, ...patch }
    };
  }

  private patchChronos(patch: Partial<SignalConfig['chronos']>): void {
    this.working = {
      ...this.working,
      chronos: { ...this.working.chronos, ...patch }
    };
  }

  private apply(): void {
    if (this.validate() !== '') return;
    const dpes = this.working.dpes
      .map((dpe) => dpe.trim())
      .filter((dpe) => dpe !== '');
    this.dispatchEvent(
      new CustomEvent<SignalConfig>('wui:apply', {
        detail: { ...this.working, label: this.working.label.trim(), dpes },
        bubbles: true,
        composed: true
      })
    );
  }

  private cancel(): void {
    this.dispatchEvent(
      new CustomEvent('wui:cancel', { bubbles: true, composed: true })
    );
  }
}

function dialogStyles(): ReturnType<typeof css> {
  return css`
    ${dialogCore()}
    .panel {
      width: 720px;
    }
    .group-title {
      font-weight: 600;
      margin: 1rem 0 0.4rem;
      padding-top: 0.6rem;
      border-top: 1px solid var(--theme-color-soft-bdr);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.75rem 1rem;
      align-items: start;
    }
    .field {
      display: flex;
      flex-direction: column;
    }
    .hint {
      color: var(--theme-color-soft-text);
      font-size: 0.8rem;
      margin: 0.2rem 0 0.6rem;
    }
    .dpe-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.35rem;
    }
    .dpe-input {
      flex: 1;
    }
    .swatch {
      width: 14px;
      height: 3px;
      border-radius: 2px;
      flex: none;
    }
    .error {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.75rem;
      color: var(--theme-color-alarm-text, #e8663c);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'sa-signal-dialog': SaSignalDialog;
  }
}
