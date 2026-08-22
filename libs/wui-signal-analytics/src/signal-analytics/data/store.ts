// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persistence and live wiring for the configured signals.
 *
 * One WinCC OA datapoint per signal, of the auto-created type `SignalAnalysis`.
 * Writes go through the PARA REST API (`/api/para/dp/*`) rather than through the
 * WebSocket: creating a type or a datapoint is an engineering operation the
 * runtime API does not offer, and the same route already carries the
 * server-side role check. Reads and subscriptions go through `OaRxJsApi`, which
 * is what makes the manager's answers arrive without polling.
 *
 * The subscription is per datapoint, not one batch over all of them: a
 * `dpConnect` fails as a whole as soon as one name in its array is unresolvable
 * (see the oa-rx-js-api README), and this page's names come and go as signals
 * are created and deleted. Isolated, a datapoint deleted from PARA mid-session
 * costs its own tile and nothing else.
 *
 * With no backend — a developer's browser, a deployment without `wui-para` — the
 * store flips to {@link SignalStore.offline} and serves an in-memory demo list,
 * so the page is explorable without a project behind it. Nothing is persisted in
 * that mode and the page says so.
 */
import { OaRxJsApi } from '@etm-professional-control/oa-rx-js-api';
import { firstValueFrom, Subscription } from 'rxjs';
import { container } from 'tsyringe';
import {
  DP_TYPE,
  LEAVES,
  withDefaults,
  type AnalysisResult,
  type LiveState,
  type SignalConfig,
  type SignalStatus
} from '../types.js';
import { demoSignals } from './demo.js';

const CREATE_TYPE_URL = '/api/para/dptype/create';
const TYPE_URL = '/api/para/dptype';
const CREATE_DP_URL = '/api/para/dp/create';
const DP_SET_URL = '/api/para/dp/set';
const DELETE_DP_BASE = '/api/para/dp';

/** Prefix of every backing datapoint, so they group in PARA and in the browser. */
const DP_PREFIX = 'SigAnalysis_';

const ID_RADIX = 36;
const SLUG_MAX = 28;
/** `/api/para/dptype/create` answers 400 when the type is already there. */
const HTTP_BAD_REQUEST = 400;

/** What the manager wrote about one signal, as it arrives. */
export interface ManagerUpdate {
  dp: string;
  status?: SignalStatus;
  result?: AnalysisResult;
  live?: LiveState;
}

function jsonPost(body: object): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/** Drop a leading `System1:` so names compare against what this page wrote. */
export function bareDp(name: string): string {
  return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
}

/**
 * Pull the JSON string out of whatever shape `dpGet` returned it in.
 *
 * The value comes back as a bare string, wrapped in `{value}`, or inside a
 * one-element array, depending on the call and the transport — so unwrap rather
 * than assume, and treat anything that is not an object literal as "empty".
 */
function jsonText(raw: unknown): string {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text.startsWith('{') ? text : '';
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const found = jsonText(entry);
      if (found !== '') return found;
    }
    return '';
  }
  if (raw && typeof raw === 'object')
    return jsonText((raw as { value?: unknown }).value);
  return '';
}

function parse<T>(raw: unknown): T | undefined {
  const text = jsonText(raw);
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** A label into an id fragment: lower-case, ASCII-ish, dash-separated. */
function slug(label: string): string {
  const cleaned = label
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
  return cleaned === '' ? 'signal' : cleaned;
}

export class SignalStore {
  /** True when nothing is persisted (no backend, or no write rights). */
  offline = false;

  private readonly api = this.resolveApi();
  private typeReady = false;
  private memory: SignalConfig[] | null = null;

  /** Live subscriptions, one per followed datapoint. */
  private readonly watches = new Map<string, Subscription>();

  // -- reading ----------------------------------------------------------------

  async list(): Promise<SignalConfig[]> {
    await this.ensureType();
    if (this.offline || !this.api) return this.mem();
    try {
      const names = (await firstValueFrom(
        this.api.dpNames('*', DP_TYPE)
      )) as string[];
      const configs: SignalConfig[] = [];
      for (const name of names) {
        const dp = bareDp(name);
        if (dp === '') continue;
        const config = await this.read(dp);
        if (config) configs.push(config);
      }
      return configs.sort((a, b) => a.label.localeCompare(b.label));
    } catch {
      this.offline = true;
      return this.mem();
    }
  }

  /** The manager-written leaves of one signal, read once (for the initial paint). */
  async readManagerState(dp: string): Promise<ManagerUpdate> {
    if (this.offline || !this.api) return { dp };
    try {
      const raw = await firstValueFrom(
        this.api.dpGet([`${dp}.status`, `${dp}.result`, `${dp}.live`])
      );
      const values = Array.isArray(raw) ? raw : [raw];
      return {
        dp,
        status: parse<SignalStatus>(values[0]),
        result: parse<AnalysisResult>(values[1]),
        live: parse<LiveState>(values[2])
      };
    } catch {
      return { dp };
    }
  }

  // -- writing ----------------------------------------------------------------

  async create(config: SignalConfig): Promise<SignalConfig> {
    const id = `${slug(config.label || config.dpes[0] || '')}-${Date.now().toString(ID_RADIX)}`;
    const created: SignalConfig = { ...config, id, dp: DP_PREFIX + id };
    if (this.offline) {
      this.mem().push(created);
      return created;
    }
    await this.send(
      CREATE_DP_URL,
      jsonPost({ dpName: created.dp, dpType: DP_TYPE })
    );
    await this.writeConfig(created);
    return created;
  }

  async save(config: SignalConfig): Promise<void> {
    if (this.offline) {
      const list = this.mem();
      const at = list.findIndex((item) => item.id === config.id);
      if (at === -1) list.push(config);
      else list[at] = config;
      return;
    }
    await this.writeConfig(config);
  }

  async remove(config: SignalConfig): Promise<void> {
    if (this.offline) {
      this.memory = this.mem().filter((item) => item.id !== config.id);
      return;
    }
    const dp = config.dp ?? DP_PREFIX + config.id;
    this.unwatch(dp);
    await this.send(
      `${DELETE_DP_BASE}/${encodeURIComponent(dp)}?dpType=${encodeURIComponent(DP_TYPE)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Ask the manager to analyse a signal.
   *
   * The request id is what lets the page tell this run's answers from the ones
   * still on the leaves from the previous run — the manager echoes it in every
   * status and result it writes.
   */
  async requestAnalysis(config: SignalConfig, user: string): Promise<string> {
    const requestId = `r-${Date.now().toString(ID_RADIX)}`;
    if (this.offline) return requestId;
    const dp = config.dp ?? DP_PREFIX + config.id;
    await this.send(
      DP_SET_URL,
      jsonPost({
        dpeName: `${dp}.command`,
        value: JSON.stringify({
          requestId,
          action: 'analyze',
          issuedAt: new Date().toISOString(),
          user
        })
      })
    );
    return requestId;
  }

  // -- live -------------------------------------------------------------------

  /**
   * Follow one signal's manager-written leaves; the callback fires on each change.
   *
   * The subscription is used as a *signal*, not as a payload: on any emission the
   * three leaves are re-read with one `dpGet`. A `dpConnect` emission carries only
   * the elements that changed and echoes their names in WinCC OA's own shape, so
   * matching values back to leaves by position or by string is a guess this page
   * does not need to make — the manager writes at most a few times per analysis,
   * and the live leaf is throttled server-side, so the extra read is cheap.
   *
   * Re-following a datapoint replaces the previous subscription, so the page can
   * call this after every reload without leaking one per refresh.
   */
  watch(dp: string, onUpdate: (update: ManagerUpdate) => void): void {
    if (this.offline || !this.api) return;
    this.unwatch(dp);
    const leaves = [`${dp}.status`, `${dp}.result`, `${dp}.live`];
    try {
      const subscription = this.api.dpConnect(leaves, true).subscribe({
        next: () => void this.readManagerState(dp).then(onUpdate),
        error: () => this.unwatch(dp)
      });
      this.watches.set(dp, subscription);
    } catch {
      /* An unresolvable name costs this signal its live updates, nothing more. */
    }
  }

  unwatch(dp: string): void {
    this.watches.get(dp)?.unsubscribe();
    this.watches.delete(dp);
  }

  unwatchAll(): void {
    for (const subscription of this.watches.values())
      subscription.unsubscribe();
    this.watches.clear();
  }

  // -- type bootstrap ---------------------------------------------------------

  private async read(dp: string): Promise<SignalConfig | undefined> {
    if (!this.api) return undefined;
    try {
      const raw = await firstValueFrom(this.api.dpGet(`${dp}.config`));
      const config = parse<Partial<SignalConfig>>(raw);
      if (!config) return undefined;
      return withDefaults({
        ...config,
        id: dp.startsWith(DP_PREFIX) ? dp.slice(DP_PREFIX.length) : dp,
        dp
      });
    } catch {
      return undefined;
    }
  }

  private async writeConfig(config: SignalConfig): Promise<void> {
    const dp = config.dp ?? DP_PREFIX + config.id;
    await this.send(
      DP_SET_URL,
      jsonPost({ dpeName: `${dp}.name`, value: config.label })
    );
    // `dpe` mirrors the first element so a config written by this page stays
    // readable to the pre-multivariate manager (and to a human in PARA).
    const payload = { ...config, dpe: config.dpes[0] ?? '' };
    await this.send(
      DP_SET_URL,
      jsonPost({ dpeName: `${dp}.config`, value: JSON.stringify(payload) })
    );
  }

  /**
   * Create the `SignalAnalysis` type on first use.
   *
   * Six flat String leaves: JSON in strings rather than a typed structure,
   * because the shape of a result changes with the engine and with the version
   * of this page, and a DP type is not something a page should be migrating on a
   * live system. A 400 means it already exists — that is a success, not a fault.
   */
  private async ensureType(): Promise<void> {
    if (this.typeReady || this.offline) return;
    if (!this.api) {
      this.offline = true;
      return;
    }
    try {
      const existing = await fetch(
        `${TYPE_URL}/${encodeURIComponent(DP_TYPE)}`
      );
      if (existing.ok) {
        this.typeReady = true;
        return;
      }
    } catch {
      this.offline = true;
      return;
    }
    try {
      const created = await fetch(
        CREATE_TYPE_URL,
        jsonPost({
          typeName: DP_TYPE,
          structure: {
            name: DP_TYPE,
            type: 'Struct',
            children: LEAVES.map((leaf) => ({
              name: leaf,
              type: 'String',
              refName: ''
            }))
          }
        })
      );
      if (created.ok || created.status === HTTP_BAD_REQUEST)
        this.typeReady = true;
      else this.offline = true;
    } catch {
      this.offline = true;
    }
  }

  private async send(url: string, init: RequestInit): Promise<void> {
    const response = await fetch(url, init);
    if (!response.ok)
      throw new Error(`${init.method ?? 'GET'} ${url} → ${response.status}`);
  }

  private mem(): SignalConfig[] {
    this.memory ??= demoSignals();
    return this.memory;
  }

  private resolveApi(): OaRxJsApi | null {
    try {
      return container.resolve<OaRxJsApi>(OaRxJsApi);
    } catch {
      return null;
    }
  }
}
