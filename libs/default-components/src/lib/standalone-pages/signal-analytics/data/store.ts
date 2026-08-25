// SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persistence and live wiring for the configured signals.
 *
 * One WinCC OA datapoint per signal, of type `SignalAnalysis`. Everything this
 * module does goes through `OaRxJsApi` — `dpGet`, `dpNames`, `dpConnect`,
 * `dpSet` — and through nothing else: no HTTP route, no REST engineering API.
 * That is the whole point of the design.
 *
 * **Why a hub.** The runtime API has no `dpCreate`: a browser can read, subscribe
 * and write values, but not engineer datapoints. So the page does not create its
 * datapoints — it asks. The manager owns one hub datapoint ({@link HUB_DP}),
 * created on its own start; the page writes a {@link HubRequest} on `request` and
 * reads the outcome on `response`. Creating and deleting a signal are therefore
 * round trips to the manager, while editing one is a plain `dpSet` on the leaves
 * the page owns.
 *
 * The subscription is per datapoint, not one batch over all of them: a
 * `dpConnect` fails as a whole as soon as one name in its array is unresolvable
 * (see the oa-rx-js-api README), and this page's names come and go as signals
 * are created and deleted. Isolated, a datapoint deleted mid-session costs its
 * own tile and nothing else.
 *
 * With no manager behind the page — a developer's browser, or a project where
 * `signal_analytics_manager.py` was never started — the hub does not exist, the
 * store flips to {@link SignalStore.offline} and serves an in-memory demo list,
 * so the page is explorable without a project behind it. Nothing is persisted in
 * that mode and the page says so.
 */
import { OaRxJsApi } from '@etm-professional-control/oa-rx-js-api';
import { firstValueFrom, Subscription } from 'rxjs';
import { container } from 'tsyringe';
import {
  DP_PREFIX,
  DP_TYPE,
  HUB_DP,
  withDefaults,
  type AnalysisResult,
  type HubInfo,
  type HubRequest,
  type HubResponse,
  type LiveState,
  type SignalConfig,
  type SignalStatus
} from '../types.js';
import { demoSignals } from './demo.js';
import { currentUserName } from './permissions.js';

const ID_RADIX = 36;
const SLUG_MAX = 28;

/**
 * How long the page waits for the manager to answer a create/delete.
 *
 * Generous on purpose: the manager may be busy analysing when the request lands,
 * and the alternative to waiting is telling the user a signal was not created
 * while the manager is in the middle of creating it.
 */
const ENGINEER_TIMEOUT_MS = 15_000;

/** What the manager wrote about one signal, as it arrives. */
export interface ManagerUpdate {
  dp: string;
  status?: SignalStatus;
  result?: AnalysisResult;
  live?: LiveState;
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
  /** True when nothing is persisted (no manager, or no write rights). */
  offline = false;

  private readonly api = this.resolveApi();

  /** The manager's identity card, once read. Absent while offline. */
  private info: HubInfo | null = null;
  private probed = false;
  private memory: SignalConfig[] | null = null;

  /** Live subscriptions, one per followed datapoint. */
  private readonly watches = new Map<string, Subscription>();

  // -- reading ----------------------------------------------------------------

  async list(): Promise<SignalConfig[]> {
    await this.probe();
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

  /** The manager's identity card, or null while offline (nothing probed yet). */
  managerInfo(): HubInfo | null {
    return this.info;
  }

  // -- writing ----------------------------------------------------------------

  /**
   * Have the manager engineer a datapoint for *config*, then write the config on it.
   *
   * The id is computed page-side so the datapoint name is readable
   * (`SigAnalysis_furnace-temp-l7k3n`), but the manager is free to answer with a
   * different one — what it reports on `response` is what the page adopts.
   */
  async create(config: SignalConfig): Promise<SignalConfig> {
    const id = `${slug(config.label || config.dpes[0] || '')}-${Date.now().toString(ID_RADIX)}`;
    const created: SignalConfig = { ...config, id, dp: DP_PREFIX + id };
    if (this.offline) {
      this.mem().push(created);
      return created;
    }
    const answer = await this.engineer({
      requestId: `c-${Date.now().toString(ID_RADIX)}`,
      op: 'create',
      issuedAt: new Date().toISOString(),
      user: currentUserName(),
      config: created
    });
    const persisted: SignalConfig = { ...created, dp: answer.dp || created.dp };
    // The manager writes the config it was handed; write it again from here so
    // an older manager that only creates the datapoint still ends up correct.
    await this.writeConfig(persisted);
    return persisted;
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
    await this.engineer({
      requestId: `d-${Date.now().toString(ID_RADIX)}`,
      op: 'delete',
      issuedAt: new Date().toISOString(),
      user: currentUserName(),
      dp
    });
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
    await this.write(
      `${dp}.command`,
      JSON.stringify({
        requestId,
        action: 'analyze',
        issuedAt: new Date().toISOString(),
        user: user || currentUserName()
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

  // -- the hub ----------------------------------------------------------------

  /**
   * Is a manager there? Read its identity card once.
   *
   * `dpGet` on a datapoint that does not exist rejects, which is exactly the
   * answer wanted: no hub means no manager has ever run against this project, so
   * nothing the page writes would be read by anyone — demonstration mode.
   */
  private async probe(): Promise<void> {
    if (this.probed) return;
    this.probed = true;
    if (!this.api) {
      this.offline = true;
      return;
    }
    try {
      const raw = await firstValueFrom(this.api.dpGet(`${HUB_DP}.info`));
      const info = parse<HubInfo>(raw);
      if (!info) {
        this.offline = true;
        return;
      }
      this.info = info;
    } catch {
      this.offline = true;
    }
  }

  /**
   * One round trip through the hub: write the request, wait for its answer.
   *
   * The response subscription is opened **before** the request is written, so a
   * manager that answers instantly cannot be missed. `dpConnect(…, true)` replays
   * whatever is currently on the leaf, which is normally the *previous* answer —
   * hence the `requestId` filter rather than "the next emission wins".
   */
  private async engineer(request: HubRequest): Promise<HubResponse> {
    const api = this.api;
    if (!api) throw new Error('no runtime API');

    return new Promise<HubResponse>((resolve, reject) => {
      // One record so the teardown can be written before the handles exist —
      // the subscription's own callback has to be able to close it.
      const pending: {
        subscription?: Subscription;
        timer?: ReturnType<typeof setTimeout>;
      } = {};

      const finish = (): void => {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.subscription?.unsubscribe();
      };

      const fail = (error: unknown): void => {
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const consider = (answer: HubResponse | undefined): void => {
        if (!answer || answer.requestId !== request.requestId) return;
        finish();
        if (answer.ok) resolve(answer);
        else reject(new Error(answer.error || `${request.op} refused`));
      };

      pending.timer = setTimeout(
        () =>
          fail(
            new Error(
              `the manager did not answer ${request.op} within ${ENGINEER_TIMEOUT_MS} ms`
            )
          ),
        ENGINEER_TIMEOUT_MS
      );

      pending.subscription = api
        .dpConnect(`${HUB_DP}.response`, true)
        .subscribe({
          next: () => {
            void firstValueFrom(api.dpGet(`${HUB_DP}.response`)).then((raw) =>
              consider(parse<HubResponse>(raw))
            );
          },
          error: fail
        });

      void this.write(`${HUB_DP}.request`, JSON.stringify(request)).catch(fail);
    });
  }

  // -- leaves the page owns ---------------------------------------------------

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
    // `dpe` mirrors the first element so a config written by this page stays
    // readable to the pre-multivariate manager (and to a human in PARA).
    const payload = { ...config, dpe: config.dpes[0] ?? '' };
    await this.write(`${dp}.name`, config.label);
    await this.write(`${dp}.config`, JSON.stringify(payload));
  }

  /**
   * Write one leaf, failing loudly.
   *
   * `dpSet` answers `false` rather than throwing when the Event manager refuses
   * the write (no write permission, unknown element) — which the caller must not
   * mistake for a success, or the page would show a signal the project never got.
   */
  private async write(dpe: string, value: string): Promise<void> {
    if (!this.api) throw new Error('no runtime API');
    const ok = await firstValueFrom(this.api.dpSet(dpe, value));
    if (ok === false) throw new Error(`dpSet ${dpe} refused`);
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
