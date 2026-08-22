// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signal Analytics — Standalone page (WinCC OA WebUI Runtime).
 *
 * Configure the datapoint elements worth watching, then read what a WinCC OA
 * **Python manager** finds in them: the stretches that resemble nothing else in
 * the period (*anomalies*), and the shapes that keep coming back (*recurrences*)
 * — first over the archived history, then continuously over the live values.
 *
 * **How the page reaches Python.** It does not, directly. WinCC OA's Python API
 * is a scripting API: it hosts no MSA vRPC service, so the pattern the other
 * backends of this repository use — an HTTP route bridging to a manager — has no
 * counterpart here. Instead each configured signal is one datapoint of type
 * `SignalAnalysis` whose leaves are split between the two sides: the page writes
 * `config` and `command`, the manager writes `status`, `result` and `live`, and
 * `dpConnect` delivers the manager's answers with no polling anywhere. See
 * `signal-analytics/types.ts` and its Python mirror,
 * `backend/python/signal_analytics/protocol.py`.
 *
 * **What each side computes.** The manager owns the analysis. The page owns the
 * curve: it reads the analysed period from the archive itself (`dpGetPeriod`),
 * because shipping tens of thousands of samples back through a String datapoint
 * would cost far more than reading them again. Findings carry absolute
 * timestamps, so they land on that curve by construction.
 *
 * **Engines.** `numpy` (matrix profile, built into the manager, always
 * available), `stumpy` (the same quantity, much faster, an optional install) and
 * `chronos` (Amazon's forecasting model — flags what was not *predictable*
 * rather than what never recurred, and needs torch). A requested engine that is
 * not installed does not fail the run: the manager analyses with `numpy` and
 * says so, which the page shows next to the result.
 *
 * Registered at `/signal-analytics` (component `wui-signal-analytics`).
 */
import { OaRxJsApi } from '@etm-professional-control/oa-rx-js-api';
import {
  hasRole$,
  registerModuleRoles,
  type AppModuleRoles
} from '@visuelconcept/wui-kit/data/app-security.js';
import '@visuelconcept/wui-kit/ui/wui-confirm-dialog.js';
import '@wincc-oa/wui-ix-wrappers/wui-content-header/wui-content-header.js';
import '@wincc-oa/wui-oarxjs-context/components/wui-context-generator/wui-context-generator.js';
import { IXCoreStyles } from '@wincc-oa/wui-shared/styles/ix-core.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Subscription } from 'rxjs';
import { container } from 'tsyringe';
import appSecurityRoles from './app-security.roles.json';
import {
  demoLive,
  demoResult,
  demoStatus
} from './signal-analytics/data/demo.js';
import {
  readHistoryMany,
  type HistoryBundle,
  type Sample
} from './signal-analytics/data/history.js';
import { LiveSignal } from './signal-analytics/data/live-signal.js';
import {
  SignalStore,
  type ManagerUpdate
} from './signal-analytics/data/store.js';
import {
  MSG,
  confirmDeleteMsg,
  engineLabel,
  fallbackMsg,
  findingsMsg,
  localize,
  localizeDir,
  stateLabel
} from './signal-analytics/i18n.js';
import {
  isBusy,
  type EngineAvailability,
  type SignalConfig,
  type SignalView
} from './signal-analytics/types.js';
import {
  SEVERITY_STEPS,
  defaultDisplayFilter,
  type DisplayFilter
} from './signal-analytics/ui/display-filter.js';
import { duration, isoDateTime } from './signal-analytics/ui/format.js';
import './signal-analytics/ui/sa-chart.js';
import type { FindingRef } from './signal-analytics/ui/sa-chart.js';
import './signal-analytics/ui/sa-findings.js';
import './signal-analytics/ui/sa-live.js';
import './signal-analytics/ui/sa-signal-dialog.js';
import './signal-analytics/ui/sa-summary.js';

/** Application-Security module id (= the page id). */
const MODULE_ID = 'signal-analytics';

/** Page title — a proper noun, identical in all three languages. */
const PAGE_TITLE = 'Signal Analytics';

@customElement('wui-signal-analytics')
export class WuiSignalAnalytics extends LitElement {
  static override readonly styles = [IXCoreStyles, pageStyles()];

  @state() private signals: SignalView[] = [];
  @state() private selectedId = '';
  @state() private history: HistoryBundle | null = null;

  /** Samples that arrived since the archived read, per element. */
  @state() private liveTails: ReadonlyMap<string, Sample[]> = new Map();

  /** What the chart and the finding lists show — transient view state. */
  @state() private filter: DisplayFilter = defaultDisplayFilter();
  @state() private finding: FindingRef = null;
  @state() private loading = false;
  @state() private offline = false;

  /** Signal being edited; `null` while the dialog is closed. */
  @state() private editing: SignalConfig | null = null;
  @state() private dialogOpen = false;
  @state() private deleting: SignalConfig | null = null;

  /** Application-Security grants — open until an admin assigns groups. */
  @state() private roleView = true;
  @state() private roleConfigure = true;
  @state() private roleRun = true;

  private readonly store = new SignalStore();
  private readonly api = this.resolveApi();
  /** Subscription on the SELECTED signal's element — one at a time, by design. */
  private readonly liveSignal = new LiveSignal(this.resolveApi());
  private roleSub = new Subscription();
  /** Guards against two history reads racing when updates arrive in a burst. */
  private historyToken = 0;

  private get selected(): SignalView | undefined {
    return this.signals.find((view) => view.config.id === this.selectedId);
  }

  /**
   * Engine availability as the manager last reported it, from any signal.
   *
   * It describes the server, not the signal, so the freshest report wins and the
   * dialog can warn about a missing engine even for a signal never analysed.
   */
  private get engineAvailability(): Record<string, EngineAvailability> | null {
    for (const view of this.signals) {
      if (view.status?.engines) return view.status.engines;
    }
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    registerModuleRoles(appSecurityRoles as AppModuleRoles);
    this.roleSub = hasRole$(MODULE_ID, 'view').subscribe(
      (granted) => (this.roleView = granted)
    );
    this.roleSub.add(
      hasRole$(MODULE_ID, 'configure').subscribe((granted) => {
        this.roleConfigure = granted;
        // Close an editor opened before the grant was revoked mid-session.
        if (!granted) this.closeDialog();
      })
    );
    this.roleSub.add(
      hasRole$(MODULE_ID, 'run').subscribe(
        (granted) => (this.roleRun = granted)
      )
    );
    void this.load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.roleSub.unsubscribe();
    this.store.unwatchAll();
    this.liveSignal.stop();
  }

  override render(): TemplateResult {
    return html`
      <wui-context-generator
        .config=${{
          headerTitle: {
            context: 'translate',
            config: {
              'en_US.utf8': PAGE_TITLE,
              'fr.utf8': PAGE_TITLE,
              'de.utf8': PAGE_TITLE
            }
          }
        }}
      >
        <wui-content-header></wui-content-header>
      </wui-context-generator>
      <div class="body">
        ${
          this.roleView
            ? html`${this.renderToolbar()} ${this.renderOffline()}
              ${this.renderContent()}`
            : html`<div class="center muted">
                ${localizeDir(MSG.page.roleForbidden)}
              </div>`
        }
      </div>
      ${this.renderDialogs()}
    `;
  }

  // --- chrome ----------------------------------------------------------------

  private renderToolbar(): TemplateResult {
    return html`
      <div class="toolbar">
        <span class="muted">${localizeDir(MSG.page.subtitle)}</span>
        <span class="spacer"></span>
        <ix-button
          variant="secondary"
          ?disabled=${this.loading}
          @click=${() => void this.load()}
        >
          <ix-icon name="refresh" slot="icon"></ix-icon
          >${localizeDir(MSG.page.refresh)}
        </ix-button>
        ${
          this.roleConfigure
            ? html`<ix-button @click=${() => this.openDialog(null)}>
                <ix-icon name="plus" slot="icon"></ix-icon
                >${localizeDir(MSG.page.newSignal)}
              </ix-button>`
            : nothing
        }
      </div>
    `;
  }

  private renderOffline(): TemplateResult | typeof nothing {
    if (!this.offline) return nothing;
    return html`<ix-message-bar type="warning" .dismissible=${false}
      >${localizeDir(MSG.page.offline)}</ix-message-bar
    >`;
  }

  private renderContent(): TemplateResult {
    if (this.signals.length === 0) {
      return html`<div class="center muted">
        ${localizeDir(MSG.page.empty)}
      </div>`;
    }
    return html`
      <div class="columns">
        <aside class="list">
          ${this.signals.map((view) => this.renderListItem(view))}
        </aside>
        ${this.renderDetail()}
      </div>
    `;
  }

  private renderListItem(view: SignalView): TemplateResult {
    const active = view.config.id === this.selectedId;
    const state = view.status?.state ?? 'idle';
    return html`
      <button
        class="item ${active ? 'active' : ''}"
        @click=${() => void this.select(view.config.id)}
      >
        <div class="item-head">
          <span class="item-name">${view.config.label}</span>
          <span class="badge ${state}">${localizeDir(stateLabel(state))}</span>
        </div>
        <div class="item-dpe muted">
          ${
            view.config.dpes.length > 1
              ? `${view.config.dpes.length} × ${view.config.dpes[0]} …`
              : view.config.dpes[0]
          }
        </div>
        <div class="item-foot muted">
          ${
            view.result
              ? localizeDir(
                  findingsMsg(
                    view.result.anomalies.length,
                    view.result.recurrences.length
                  )
                )
              : localizeDir(MSG.detail.notAnalysed)
          }
          ${view.live?.anomaly ? html`<ix-icon name="warning" size="12" class="alarm"></ix-icon>` : nothing}
          ${view.config.enabled ? nothing : html`<span>· ${localizeDir(MSG.list.disabled)}</span>`}
        </div>
      </button>
    `;
  }

  // --- detail ----------------------------------------------------------------

  private renderDetail(): TemplateResult {
    const view = this.selected;
    if (!view) return html`<section class="detail"></section>`;
    return html`
      <section class="detail">
        ${this.renderDetailHead(view)} ${this.renderStatus(view)}
        <sa-summary
          .result=${view.result}
          .status=${view.status}
          .config=${view.config}
        ></sa-summary>
        <div class="panel">
          <div class="panel-title">
            ${localizeDir(MSG.detail.history)}
            ${
              this.history?.synthetic
                ? html`<span class="muted small"
                    >— ${localizeDir(MSG.detail.syntheticCurve)}</span
                  >`
                : nothing
            }
            <span class="spacer"></span>
            ${this.renderFilterBar(view)}
          </div>
          <sa-chart
            .series=${this.history?.series ?? []}
            .liveSeries=${this.liveTails}
            .result=${view.result}
            .selected=${this.finding}
            .filter=${this.filter}
            ?synthetic=${this.history?.synthetic === true}
          ></sa-chart>
        </div>
        <div class="panel">
          <sa-findings
            .result=${view.result}
            .selected=${this.finding}
            .filter=${this.filter}
            @wui:select=${(event: CustomEvent<FindingRef>) => (this.finding = event.detail)}
          ></sa-findings>
        </div>
        <div class="panel">
          <div class="panel-title">${localizeDir(MSG.detail.liveTitle)}</div>
          <sa-live
            .live=${view.live}
            ?enabled=${view.config.realtime.enabled}
          ></sa-live>
        </div>
      </section>
    `;
  }

  private renderDetailHead(view: SignalView): TemplateResult {
    const busy = isBusy(view.status);
    return html`
      <div class="detail-head">
        <div>
          <ix-typography format="h3">${view.config.label}</ix-typography>
          <div class="muted small">
            ${view.config.dpes.join(' · ')} ·
            ${localizeDir(engineLabel(view.config.engine))}
          </div>
        </div>
        <span class="spacer"></span>
        ${
          this.roleRun
            ? html`<ix-button
                ?disabled=${busy || !view.config.enabled}
                @click=${() => void this.analyse(view)}
              >
                <ix-icon name="play" slot="icon"></ix-icon
                >${localizeDir(MSG.actions.analyse)}
              </ix-button>`
            : nothing
        }
        ${
          this.roleConfigure
            ? html`
                <ix-icon-button
                  ghost
                  icon="pen"
                  title=${localize(MSG.actions.edit)}
                  @click=${() => this.openDialog(view.config)}
                ></ix-icon-button>
                <ix-icon-button
                  ghost
                  icon="trashcan"
                  title=${localize(MSG.actions.delete)}
                  @click=${() => (this.deleting = view.config)}
                ></ix-icon-button>
              `
            : nothing
        }
      </div>
    `;
  }

  /**
   * The manager's own account of the last run.
   *
   * Silence is a state of its own here: a signal whose datapoint exists but
   * whose `status` leaf was never written means the manager is not running, and
   * saying so beats leaving the operator to wonder why "Analyse" does nothing.
   */
  private renderStatus(view: SignalView): TemplateResult {
    const status = view.status;
    if (!status) {
      return html`<ix-message-bar type="warning" .dismissible=${false}
        >${localizeDir(MSG.page.managerSilent)}</ix-message-bar
      >`;
    }

    const result = view.result;
    return html`
      <div class="status">
        <span class="badge ${status.state}"
          >${localizeDir(stateLabel(status.state))}</span
        >
        ${
          isBusy(status)
            ? html`<ix-progress-indicator
                  .value=${status.progress}
                  .max=${100}
                ></ix-progress-indicator>
                <span class="muted small">${status.message}</span>`
            : html`<span class="muted small">${status.message}</span>`
        }
        ${
          status.fallback
            ? html`<span class="warn small"
                >${localizeDir(fallbackMsg(status.engine, status.fallbackReason ?? ''))}</span
              >`
            : nothing
        }
        <span class="spacer"></span>
        ${
          result
            ? html`<span class="muted small">
                ${localizeDir(MSG.detail.analysedOn)}
                ${isoDateTime(result.computedAt)} ·
                ${localizeDir(MSG.detail.took)} ${duration(result.durationMs)} ·
                ${localizeDir(MSG.detail.sampleStep)}
                ${duration(status.stepMs ?? 0)}
              </span>`
            : nothing
        }
      </div>
      ${
        status.state === 'error'
          ? html`<ix-message-bar type="alarm" .dismissible=${false}
              >${status.message}</ix-message-bar
            >`
          : nothing
      }
    `;
  }

  /**
   * The display filter, as chips on the chart panel's own title row.
   *
   * One object drives the chart AND the lists, so hiding a kind here collapses
   * it everywhere at once — two views disagreeing about what is visible is the
   * confusion a filter exists to remove. Transient by design: it filters what
   * is looked at, never what was found.
   */
  private renderFilterBar(view: SignalView): TemplateResult | typeof nothing {
    if (!view.result) return nothing;
    return html`
      <span class="filters">
        <button
          class="filter-chip anomalies ${this.filter.anomalies ? 'on' : ''}"
          @click=${() => this.patchFilter({ anomalies: !this.filter.anomalies })}
        >
          ${localizeDir(MSG.filters.anomalies)}
        </button>
        <button
          class="filter-chip recurrences ${this.filter.recurrences ? 'on' : ''}"
          @click=${() => this.patchFilter({ recurrences: !this.filter.recurrences })}
        >
          ${localizeDir(MSG.filters.recurrences)}
        </button>
        <button
          class="filter-chip band ${this.filter.band ? 'on' : ''}"
          @click=${() => this.patchFilter({ band: !this.filter.band })}
        >
          ${localizeDir(MSG.filters.band)}
        </button>
        <span class="filter-label muted small"
          >${localizeDir(MSG.filters.minSeverity)}</span
        >
        ${SEVERITY_STEPS.map(
          (step) => html`
            <button
              class="filter-chip severity ${this.filter.minSeverity === step ? 'on' : ''}"
              @click=${() => this.patchFilter({ minSeverity: step })}
            >
              ${step === 0 ? localizeDir(MSG.filters.all) : `≥×${step}`}
            </button>
          `
        )}
      </span>
    `;
  }

  private patchFilter(patch: Partial<DisplayFilter>): void {
    this.filter = { ...this.filter, ...patch };
  }

  private renderDialogs(): TemplateResult {
    return html`
      ${
        this.dialogOpen
          ? html`<sa-signal-dialog
              .signal=${this.editing}
              .engines=${this.engineAvailability}
              .stepMs=${this.selected?.status?.stepMs ?? 0}
              @wui:apply=${(event: CustomEvent<SignalConfig>) => void this.persist(event.detail)}
              @wui:cancel=${() => this.closeDialog()}
            ></sa-signal-dialog>`
          : nothing
      }
      ${
        this.deleting
          ? html`<wui-confirm-dialog
              heading=${localize(MSG.confirm.deleteTitle)}
              message=${localize(confirmDeleteMsg(this.deleting.label))}
              @wui:confirm=${() => void this.deleteSignal()}
              @wui:cancel=${() => (this.deleting = null)}
            ></wui-confirm-dialog>`
          : nothing
      }
    `;
  }

  // --- data ------------------------------------------------------------------

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const configs = await this.store.list();
      this.offline = this.store.offline;
      this.signals = configs.map((config) => this.initialView(config));

      if (!this.offline) {
        for (const view of this.signals) {
          const dp = view.config.dp;
          if (!dp) continue;
          this.applyUpdate(await this.store.readManagerState(dp));
          this.store.watch(dp, (update) => this.applyUpdate(update));
        }
      }

      const stillThere = this.signals.some(
        (view) => view.config.id === this.selectedId
      );
      await this.select(
        stillThere ? this.selectedId : (this.signals[0]?.config.id ?? '')
      );
    } finally {
      this.loading = false;
    }
  }

  /** Offline, the demo signals come with demo findings — otherwise nothing yet. */
  private initialView(config: SignalConfig): SignalView {
    if (!this.offline)
      return { config, status: null, result: null, live: null };
    return {
      config,
      status: demoStatus(config),
      result: demoResult(config),
      live: demoLive(config)
    };
  }

  /**
   * Merge one manager write into the view, and refresh the curve when the
   * analysed period moved.
   *
   * Only a *new* result reloads the history: `live` is rewritten every few
   * seconds, and re-reading the archive on each of those would turn a rolling
   * score into a steady stream of archive queries.
   */
  private applyUpdate(update: ManagerUpdate): void {
    let periodChanged = false;
    this.signals = this.signals.map((view) => {
      if (view.config.dp !== update.dp) return view;
      const result = update.result ?? view.result;
      if (view.config.id === this.selectedId && result !== view.result)
        periodChanged = true;
      return {
        config: view.config,
        status: update.status ?? view.status,
        result,
        live: update.live ?? view.live
      };
    });
    if (periodChanged) {
      this.finding = null;
      void this.loadHistory();
    }
  }

  private async select(id: string): Promise<void> {
    if (id === this.selectedId && this.history) return;
    this.selectedId = id;
    this.finding = null;
    this.history = null;
    this.liveTails = new Map();
    await this.loadHistory();
  }

  /**
   * Subscribe the selected signal's element so its curve keeps growing.
   *
   * One subscription, on the signal being looked at: following all of them would
   * mean N hotlinks for N-1 curves nobody is watching. It is not gated on the
   * signal being *enabled* — that flag tells the manager whether to analyse, and
   * says nothing about whether the operator wants to see the values.
   */
  private followLive(): void {
    const view = this.selected;
    if (!view || this.offline || view.config.dpes.every((dpe) => dpe === '')) {
      this.liveSignal.stop();
      this.liveTails = new Map();
      return;
    }
    this.liveSignal.follow(view.config.dpes, (tails) => {
      this.liveTails = tails;
    });
  }

  /**
   * Read the curve for the selected signal.
   *
   * The window is the analysed one when there is a result, so findings and curve
   * cover the same period; otherwise it is the configured history, so a signal
   * that has never been analysed still shows what it looks like.
   */
  private async loadHistory(): Promise<void> {
    const view = this.selected;
    if (!view) {
      this.history = null;
      // Nothing selected (the last signal was just deleted) — the subscription
      // has to go with it, or it streams curves nobody is drawing.
      this.followLive();
      return;
    }
    const token = ++this.historyToken;
    const to = view.result?.to ?? Date.now();
    const from =
      view.result?.from ?? to - view.config.history.hours * 3_600_000;
    const bundle = await readHistoryMany(
      this.offline ? null : this.api,
      view.config.dpes,
      from,
      to
    );
    // A newer selection (or result) started its own read while this one ran.
    if (token !== this.historyToken) return;
    this.history = bundle;
    // The archive just re-read everything the tails were holding, so start them
    // over rather than drawing those samples twice — once from each source.
    this.liveSignal.reset();
    this.liveTails = new Map();
    this.followLive();
  }

  // --- actions ---------------------------------------------------------------

  private async analyse(view: SignalView): Promise<void> {
    if (!this.roleRun) return;
    await this.store.requestAnalysis(view.config, '');
    // Show "queued" at once: the manager's own status write follows within a
    // second, but a button that appears to do nothing until then reads as broken.
    this.signals = this.signals.map((item) =>
      item.config.id === view.config.id
        ? {
            ...item,
            status: {
              ...(item.status ?? {
                requestId: '',
                progress: 0,
                engine: item.config.engine,
                engineRequested: item.config.engine,
                fallback: false,
                runtime: '',
                updatedAt: new Date().toISOString()
              }),
              state: 'queued',
              message: '',
              progress: 0
            } as SignalView['status']
          }
        : item
    );
  }

  private openDialog(config: SignalConfig | null): void {
    if (!this.roleConfigure) return;
    this.editing = config;
    this.dialogOpen = true;
  }

  private closeDialog(): void {
    this.dialogOpen = false;
    this.editing = null;
  }

  private async persist(config: SignalConfig): Promise<void> {
    const isNew = this.editing === null;
    this.closeDialog();
    if (isNew) {
      const created = await this.store.create(config);
      this.offline = this.store.offline;
      this.signals = [...this.signals, this.initialView(created)];
      if (created.dp && !this.offline)
        this.store.watch(created.dp, (update) => this.applyUpdate(update));
      await this.select(created.id);
      return;
    }
    await this.store.save(config);
    this.offline = this.store.offline;
    this.signals = this.signals.map((view) =>
      view.config.id === config.id ? { ...view, config } : view
    );
    await this.loadHistory();
  }

  private async deleteSignal(): Promise<void> {
    const target = this.deleting;
    this.deleting = null;
    if (!target) return;
    await this.store.remove(target);
    this.signals = this.signals.filter((view) => view.config.id !== target.id);
    if (this.selectedId === target.id)
      await this.select(this.signals[0]?.config.id ?? '');
  }

  private resolveApi(): OaRxJsApi | null {
    try {
      return container.resolve<OaRxJsApi>(OaRxJsApi);
    } catch {
      return null;
    }
  }
}

// eslint-disable-next-line max-lines-per-function -- single stylesheet literal
function pageStyles(): ReturnType<typeof css> {
  return css`
    :host {
      display: block;
      height: 100%;
      color: var(--theme-color-std-text);
    }
    .body {
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .spacer {
      flex: 1;
    }
    .columns {
      display: grid;
      grid-template-columns: minmax(240px, 320px) 1fr;
      gap: 1rem;
      align-items: start;
    }
    @media (max-width: 900px) {
      .columns {
        grid-template-columns: 1fr;
      }
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .item {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      text-align: left;
      padding: 0.6rem 0.7rem;
      border-radius: var(--theme-default-border-radius);
      border: 1px solid var(--theme-color-soft-bdr);
      background: var(--theme-color-2);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .item:hover {
      background: var(--theme-color-3);
    }
    .item.active {
      border-color: var(--theme-color-primary);
      background: var(--theme-color-3);
    }
    .item-head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .item-name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item-dpe,
    .item-foot {
      font-size: 0.8rem;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .badge {
      margin-left: auto;
      font-size: 0.72rem;
      padding: 0.05rem 0.4rem;
      border-radius: 999px;
      border: 1px solid var(--theme-color-soft-bdr);
      color: var(--theme-color-soft-text);
      white-space: nowrap;
    }
    .badge.running,
    .badge.queued {
      border-color: var(--theme-color-primary);
      color: var(--theme-color-primary);
    }
    .badge.done {
      border-color: #41b883;
      color: #41b883;
    }
    .badge.error {
      border-color: #e8663c;
      color: #e8663c;
    }
    .detail {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      min-width: 0;
    }
    .detail-head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .status .badge {
      margin-left: 0;
    }
    .status ix-progress-indicator {
      width: 160px;
    }
    .panel {
      border: 1px solid var(--theme-color-soft-bdr);
      border-radius: var(--theme-default-border-radius);
      background: var(--theme-color-2);
      padding: 0.75rem;
    }
    .panel-title {
      font-weight: 600;
      margin-bottom: 0.4rem;
      display: flex;
      align-items: baseline;
      gap: 0.4rem;
    }
    .center {
      text-align: center;
      padding: 3rem 1rem;
    }
    .muted {
      color: var(--theme-color-soft-text);
    }
    .warn {
      color: #e0a458;
    }
    .small {
      font-size: 0.82rem;
    }
    .alarm {
      color: #e8663c;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'wui-signal-analytics': WuiSignalAnalytics;
  }
}
