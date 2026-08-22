// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The analysed period, with the findings drawn on it.
 *
 * Layers over one shared time axis, because the whole point of the page is that
 * they line up:
 *
 * 1. the signal — or, for a joint analysis, **one curve per element**, each in
 *    its own colour matching the legend and the contribution shares elsewhere
 *    on the page. Wildly different magnitudes (a temperature over a gas flow)
 *    are split onto a second value axis so neither flattens the other;
 * 2. the findings as **bands**, not points — an anomaly and a recurrence both
 *    have a duration, and a marker at the start of a shape hides the very thing
 *    that makes it one. Anomaly bands carry their **rank number**, which is what
 *    lets a band be matched to its row in the list at a glance;
 * 3. the manager's score curve underneath, on its own axis, with the threshold
 *    as a horizontal line — the answer to the question a list of findings
 *    cannot answer: *how close to the line was everything else?*
 *
 * What is shown is governed by the page's {@link DisplayFilter}: band kinds can
 * be toggled and anomalies floored by severity, because a busy period can put
 * thirty bands on screen and readability IS the feature here.
 *
 * Selecting a finding elsewhere on the page highlights its band rather than
 * zooming to it: an anomaly that has to be read against the surrounding cycles
 * loses its meaning when the surrounding cycles are scrolled off-screen.
 *
 * The curve **keeps growing**. The archived part is read once for the analysed
 * period; everything the process does afterwards arrives on a subscription
 * (`data/live-signal.ts`) and is appended past its end, with a marker line where
 * the analysis stopped — so it stays obvious that the findings describe the left
 * of that line and not the right.
 *
 * `echarts` resolves through the shared-bundle import map (externalised by
 * `build:pages`), as on the other standalone pages.
 */
import { IXCoreStyles } from '@wincc-oa/wui-shared/styles/ix-core.js';
import * as echarts from 'echarts';
import {
  LitElement,
  css,
  html,
  type PropertyValues,
  type TemplateResult
} from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Sample } from '../data/history.js';
import type { AnalysisResult } from '../types.js';
import {
  defaultDisplayFilter,
  passesFilter,
  type DisplayFilter
} from './display-filter.js';

const CHART_HEIGHT_PX = 360;

/**
 * One colour per element curve — matched by `elementColor()` wherever an
 * element is named (legend, contributions), so "the orange signal" means the
 * same thing everywhere on the page.
 */
export const SERIES_PALETTE = [
  '#3ba1e0',
  '#e0a458',
  '#9b59b6',
  '#16a085',
  '#d35480',
  '#7f8c8d'
];

/** Deliberately not the theme's alarm red: these are findings, not alarms. */
const ANOMALY_COLOR = '#e8663c';
const RECURRENCE_COLOR = '#41b883';
const PROFILE_COLOR = '#9b8bd6';
const THRESHOLD_COLOR = '#c0392b';
/** The "analysed up to here" divider — a boundary, not a value. */
const BOUNDARY_COLOR = '#8a8a8a';

/** Theme token for secondary chart text — axes, legend. */
const SOFT_TEXT = 'var(--theme-color-soft-text)';

/** Opacity of an anomaly band that is not the selected one. */
const BAND_ALPHA = 0.16;
const BAND_ALPHA_ACTIVE = 0.38;

/**
 * Recurrence bands are much fainter than anomaly bands: a healthy cyclic signal
 * has an occurrence band on EVERY cycle, and at anomaly opacity three dozen of
 * them tint the whole chart — the exceptional must out-ink the routine.
 */
const RECURRENCE_ALPHA = 0.06;
const RECURRENCE_ALPHA_ACTIVE = 0.28;

/** Ratio of magnitudes beyond which a curve earns the second value axis. */
const AXIS_SPLIT_RATIO = 20;

export type FindingRef = { kind: 'anomaly' | 'recurrence'; id: string } | null;

/** One element's curve, archived part only — the live tail comes in separately. */
export interface ChartSeries {
  dpe: string;
  samples: Sample[];
}

/** The colour an element keeps across the whole page. */
export function elementColor(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}

/** `System1:SigSim_Furnace01.temperature` → `temperature` (legend-sized). */
export function shortName(dpe: string): string {
  const bare = dpe.includes(':') ? dpe.slice(dpe.indexOf(':') + 1) : dpe;
  const parts = bare.replace(/\.+$/, '').split('.');
  return parts.at(-1) || bare;
}

/**
 * One shaded span: a `[start, end]` pair of `markArea` items.
 *
 * Declared here because echarts does not export the type of a 2-D markArea
 * datum — only the option object that contains it — and `any` would give up the
 * one thing that matters, that a band is always a pair.
 */
type MarkAreaBand = [
  {
    xAxis: number;
    name?: string;
    label?: object;
    itemStyle: {
      color: string;
      opacity: number;
      borderColor: string;
      borderWidth: number;
    };
  },
  { xAxis: number }
];

@customElement('sa-chart')
export class SaChart extends LitElement {
  static override readonly styles = [IXCoreStyles, chartStyles()];

  /** The archived curves, one per analysed element. */
  @property({ attribute: false }) series: ChartSeries[] = [];

  /** Values that arrived after the archived read, per element. */
  @property({ attribute: false }) liveSeries: ReadonlyMap<string, Sample[]> =
    new Map();

  @property({ attribute: false }) result: AnalysisResult | null = null;

  /** Finding highlighted from the lists beside the chart. */
  @property({ attribute: false }) selected: FindingRef = null;

  /** What to draw — owned by the page, shared with the finding lists. */
  @property({ attribute: false }) filter: DisplayFilter =
    defaultDisplayFilter();

  /** Drawn dimmed with a "simulated" note when the archive returned nothing. */
  @property({ type: Boolean }) synthetic = false;

  private chart: echarts.ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Identifies the drawing whose *structure* is on screen — see `updated()`. */
  private structure = '';

  override render(): TemplateResult {
    return html`<div class="chart" id="chart"></div>`;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.chart?.dispose();
    this.chart = null;
  }

  protected override updated(_changed: PropertyValues): void {
    const host = this.renderRoot.querySelector<HTMLElement>('#chart');
    if (!host) return;
    if (!this.chart) {
      this.chart = echarts.init(host);
      this.resizeObserver = new ResizeObserver(() => this.chart?.resize());
      this.resizeObserver.observe(host);
    }
    // Replace only when the *structure* changed — another signal, another
    // analysis, another selected finding, another filter. A live tick changes
    // nothing but the series data, and replacing on each one would reset the
    // operator's zoom every second; merging leaves it alone. Replacing when the
    // findings DO change is equally necessary: echarts merges arrays
    // element-wise and would leave the previous run's bands behind.
    const structure = this.structureKey();
    const replace = structure !== this.structure;
    this.structure = structure;
    this.chart.setOption(this.option(), replace);
  }

  private structureKey(): string {
    const result = this.result;
    return [
      this.series.map((entry) => entry.dpe).join(','),
      result?.requestId ?? '',
      result?.computedAt ?? '',
      result?.profile ? 'band' : 'no-band',
      this.selected?.kind ?? '',
      this.selected?.id ?? '',
      this.synthetic ? 'synthetic' : 'archived',
      JSON.stringify(this.filter)
    ].join('|');
  }

  private option(): echarts.EChartsOption {
    const axisOf = this.axisAssignment();
    const series: echarts.SeriesOption[] = this.series.map((entry, index) =>
      this.signalSeries(entry, index, axisOf[index])
    );
    const profile = this.filter.band ? this.profileSeries() : null;
    if (profile) series.push(profile);

    return {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 56, right: 64, top: 30, bottom: 44 },
      legend:
        this.series.length > 1
          ? {
              top: 0,
              textStyle: { color: SOFT_TEXT },
              icon: 'roundRect',
              itemWidth: 14,
              itemHeight: 3
            }
          : undefined,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        confine: true
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: 'var(--theme-color-soft-bdr)' } },
        axisLabel: { color: SOFT_TEXT, hideOverlap: true },
        splitLine: { show: false }
      },
      yAxis: [
        {
          type: 'value',
          scale: true,
          axisLabel: { color: SOFT_TEXT },
          splitLine: {
            lineStyle: { color: 'var(--theme-color-soft-bdr)', opacity: 0.4 }
          }
        },
        {
          type: 'value',
          scale: true,
          axisLabel: { color: SOFT_TEXT, fontSize: 10 },
          splitLine: { show: false }
        },
        {
          type: 'value',
          scale: true,
          // The score axis carries no unit an operator would recognise, so it
          // is labelled only enough to read the threshold against it.
          axisLabel: { color: PROFILE_COLOR, fontSize: 10 },
          splitLine: { show: false },
          position: 'right',
          offset: 34
        }
      ],
      dataZoom: [
        { type: 'inside', throttle: 50 },
        { type: 'slider', height: 18, bottom: 8 }
      ],
      series
    };
  }

  /**
   * Which of the two value axes each element curve uses.
   *
   * A temperature in the hundreds over a gas flow in the tens flattens the flow
   * into a decoration; a second axis keeps both readable. Assignment is by
   * magnitude: everything within {@link AXIS_SPLIT_RATIO} of the largest curve
   * shares axis 0, the rest take axis 1.
   */
  private axisAssignment(): number[] {
    if (this.series.length < 2) return this.series.map(() => 0);
    const magnitudes = this.series.map((entry) => {
      let largest = 0;
      for (const sample of entry.samples)
        largest = Math.max(largest, Math.abs(sample.v));
      return largest;
    });
    const reference = Math.max(...magnitudes, 1e-9);
    return magnitudes.map((magnitude) =>
      reference / Math.max(magnitude, 1e-9) > AXIS_SPLIT_RATIO ? 1 : 0
    );
  }

  private signalSeries(
    entry: ChartSeries,
    index: number,
    yAxisIndex: number
  ): echarts.SeriesOption {
    const color = elementColor(index);
    return {
      type: 'line',
      name: shortName(entry.dpe),
      yAxisIndex,
      showSymbol: false,
      sampling: 'lttb',
      lineStyle: { width: 1.4, color, opacity: this.synthetic ? 0.55 : 1 },
      itemStyle: { color },
      data: this.curve(entry).map((sample) => [sample.t, sample.v]),
      // The bands and the boundary ride on the FIRST series only — they mark
      // moments, not values, and duplicating them per curve doubles their ink.
      markArea: index === 0 ? this.markArea() : undefined,
      markLine: index === 0 ? this.analysedUntil() : undefined
    };
  }

  /**
   * The archived curve followed by the live tail of the same element.
   *
   * Only samples strictly newer than the last archived one are appended: the
   * two sources overlap by construction — the subscription starts before the
   * archive read returns — and a duplicated instant would draw the curve back
   * on itself.
   */
  private curve(entry: ChartSeries): Sample[] {
    const tail = this.liveSeries.get(entry.dpe) ?? [];
    if (tail.length === 0) return entry.samples;
    const lastArchived = entry.samples.at(-1)?.t ?? -Infinity;
    const fresh = tail.filter((sample) => sample.t > lastArchived);
    return fresh.length === 0 ? entry.samples : [...entry.samples, ...fresh];
  }

  private profileSeries(): echarts.SeriesOption | null {
    const profile = this.result?.profile;
    if (!profile || profile.t.length === 0) return null;
    return {
      type: 'line',
      name: 'score',
      yAxisIndex: 2,
      showSymbol: false,
      lineStyle: { width: 1, color: PROFILE_COLOR, opacity: 0.75 },
      areaStyle: { color: PROFILE_COLOR, opacity: 0.1 },
      data: profile.t.map((time, index) => [time, profile.v[index]]),
      markLine: this.thresholdLine()
    };
  }

  /** The anomaly cut-off, so every score is read against the same line. */
  private thresholdLine(): echarts.SeriesOption['markLine'] {
    const threshold = this.result?.threshold;
    if (threshold == null || !Number.isFinite(threshold)) return undefined;
    return {
      silent: true,
      symbol: 'none',
      lineStyle: { color: THRESHOLD_COLOR, type: 'dashed', width: 1 },
      label: { show: false },
      data: [{ yAxis: threshold }]
    };
  }

  /**
   * Where the analysis stopped looking.
   *
   * Without it the live tail reads as part of the analysed period, and its
   * absence of findings as "nothing wrong here" rather than "not examined yet".
   */
  private analysedUntil(): echarts.SeriesOption['markLine'] {
    const until = this.result?.to;
    if (until == null) return undefined;
    const anyTail = [...this.liveSeries.values()].some(
      (tail) => (tail.at(-1)?.t ?? 0) > until
    );
    if (!anyTail) return undefined;
    return {
      silent: true,
      symbol: 'none',
      lineStyle: { color: BOUNDARY_COLOR, type: 'dotted', width: 1 },
      label: { show: false },
      data: [{ xAxis: until }]
    };
  }

  /**
   * Anomalies and recurrence occurrences as shaded spans, post-filter.
   *
   * Anomaly bands carry their rank as a label — the number that matches the row
   * in the list. A recurrence contributes one band per occurrence: the finding
   * is "this happened four times", and four bands is the only drawing that says
   * it.
   */
  private markArea(): echarts.SeriesOption['markArea'] {
    const result = this.result;
    if (!result) return undefined;

    const areas: MarkAreaBand[] = [];

    if (this.filter.anomalies) {
      for (const anomaly of result.anomalies) {
        if (!passesFilter(anomaly, this.filter)) continue;
        const active =
          this.selected?.kind === 'anomaly' &&
          this.selected.id === String(anomaly.rank);
        areas.push(
          this.band(
            anomaly.start,
            anomaly.end,
            ANOMALY_COLOR,
            active,
            `${anomaly.rank}`
          )
        );
      }
    }
    if (this.filter.recurrences) {
      for (const recurrence of result.recurrences) {
        const active =
          this.selected?.kind === 'recurrence' &&
          this.selected.id === recurrence.id;
        for (const occurrence of recurrence.occurrences) {
          areas.push(
            this.band(
              occurrence.start,
              occurrence.end,
              RECURRENCE_COLOR,
              active,
              undefined,
              active ? RECURRENCE_ALPHA_ACTIVE : RECURRENCE_ALPHA
            )
          );
        }
      }
    }

    return { silent: true, data: areas };
  }

  private band(
    start: number,
    end: number,
    color: string,
    active: boolean,
    label?: string,
    alpha?: number
  ): MarkAreaBand {
    return [
      {
        xAxis: start,
        name: label,
        label:
          label === undefined
            ? undefined
            : {
                show: true,
                position: 'insideTop',
                color,
                fontSize: 10,
                fontWeight: 'bold',
                distance: 2
              },
        itemStyle: {
          color,
          opacity: alpha ?? (active ? BAND_ALPHA_ACTIVE : BAND_ALPHA),
          borderColor: color,
          borderWidth: active ? 1 : 0
        }
      },
      // A zero-width band would be invisible; one second is the smallest span
      // that still draws on a multi-hour axis.
      { xAxis: Math.max(end, start + 1000) }
    ];
  }
}

function chartStyles(): ReturnType<typeof css> {
  return css`
    :host {
      display: block;
    }
    .chart {
      width: 100%;
      height: ${CHART_HEIGHT_PX}px;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'sa-chart': SaChart;
  }
}
