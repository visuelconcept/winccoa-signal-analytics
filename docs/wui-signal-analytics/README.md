# @visuelconcept/wui-signal-analytics — source module (Tier 3)

**Signal Analytics** page for a WinCC OA WebUI dashboard: **`/signal-analytics`**.

Pick the datapoint elements worth watching, and a **WinCC OA Python manager**
tells you two things about each of them:

- **anomalies** — the stretches of signal that resemble nothing else in the
  period, ranked, with a duration and a severity;
- **recurrences** — the shapes that keep coming back, with every occurrence and
  the median cycle time between them.

A signal names **one or several datapoint elements**. Several elements mean ONE
**joint analysis** (mSTAMP): anomalies that only exist in the *correlation*
between signals — the power collapses while the temperature keeps climbing —
become detectable, and each anomaly names the share every signal had in it.

First over the **archived history**, then **continuously on the live values**:
after an analysis, every new value is scored against what the history taught, on
the same scale, so the threshold learnt offline is the alarm line online.

Three analysis engines, chosen per signal:

| Engine | Question it answers | Install |
| --- | --- | --- |
| **Matrix profile (built in)** | *Has this shape occurred before?* | none — plain NumPy, ships with the manager |
| **STUMPY** | the same quantity, much faster on long periods | `pip install stumpy` on the server |
| **Chronos** | *Was this what should have come next?* — a pretrained forecasting model, so a first-time excursion counts without waiting for a second occurrence | `pip install chronos-forecasting torch` — multi-gigabyte, and a model download |

An engine that is not installed **never fails a run**: the manager analyses with
the built-in one and the page says which, and why.

## Why this page has no HTTP route

The backends of the `winccoa-wui-pages` collection are *JavaScript* managers
publishing an MSA vRPC service that a webserver route calls. **WinCC OA's
Python API is a scripting API — it hosts no vRPC service**, so that pattern has
no Python counterpart.

The bridge is therefore the datapoint system itself. One datapoint per configured
signal (type `SignalAnalysis`, auto-created), six String leaves carrying JSON,
split by writer:

```
page   ──▶  name · config · command          the request
manager ──▶ status · result · live           the answer      (delivered by dpConnect)
```

No leaf is written by both sides, so neither can clobber the other, and the page
gets progress and results pushed with no polling anywhere. The contract is
[`types.ts`](../../libs/wui-signal-analytics/src/signal-analytics/types.ts) on
one side and
[`protocol.py`](../../backend/python/signal_analytics/protocol.py) on the other.

**The samples are never sent back.** The page reads the analysed period from the
archive itself with `dpGetPeriod`; findings carry absolute timestamps and land on
that curve by construction.

## Install

Deployed with the repository's standard tooling:

```bash
# frontend (from a wired dev workspace — see DEVELOPMENT.md)
OUT_DIR="<project>/data/dashboard-wc" npm run build:pages

# Python managers (copies backend/python/ → <project>/python/, adds the config/progs lines)
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics
```

## After install (required)

1. **CPython must be on the machine.** WinCC OA ships no interpreter — see
   [Prerequisites](#prerequisites).
2. **Start `signal_analytics_manager.py`** in the WinCC OA console. Nothing
   starts it for you; the deploy script only writes the `config/progs` line.
   Until it runs, the page shows *"The Python manager has never answered on this
   signal"* against each configured signal.
3. **Browser:** a plain **F5** — the build touches `index.html`, so the service
   worker purges its caches.

To verify the manager came up, look for its startup line in
`<project>/log/PVSS_II.log`; its own file is `<project>/log/python<num>.log`.

## Prerequisites

- **Setup component `PythonEnv`** on the machine that runs the manager (ships the
  native extension and the `etm.wccoa` packages).
- **CPython**, in the version released for the OS — 3.12 on Windows 11 / Server
  2022 / 2025, 3.13 on Debian 13, 3.11 on Debian 12. WinCC OA looks in
  `<project>/bin/`, then subprojects, then the installation, then `PATH`. **If
  several Pythons are installed, put the right one in `<project>/bin/`** — the
  first on `PATH` wins otherwise.
- **NumPy** in that interpreter (`pip install numpy`). It is the only hard
  third-party dependency; `stumpy` and `chronos-forecasting` are optional and
  detected at runtime.
- **`@visuelconcept/wui-para`** (the `/api/para` route) — the page creates the
  `SignalAnalysis` DP type and its datapoints through it. Without it the page
  still opens, in **demonstration mode** on fabricated findings, and says so.
- **The analysed elements must be archived.** The manager reads history with
  `dp_get_period_split` over `:_original.._value`; an element with no archive
  yields *"no archived numeric value in the requested period"*.

## Configuring a signal

| Field | What it does |
| --- | --- |
| **Datapoint element** | The archived element to analyse, e.g. `System1:ExampleDP_Trend1.` |
| **Window (samples)** | The length of the shape being looked for. Once a first analysis has established the sample step, the dialog shows it as a duration ("64 samples ≈ 3 min 12 s") — which is the number that says whether you are looking for a valve stroke or a shift pattern. |
| **History (hours)** | How far back to read. |
| **Max points analysed** | The period is resampled to this many points. The matrix profile costs **O(n²)**: 20 000 points is a few seconds, 60 000 is a minute. |
| **Sensitivity** | Anomaly threshold in robust sigmas over the score curve. Lower reports more. |
| **Recurrence tolerance** | How different an occurrence may be and still count as the same shape. |
| **Watch live values** | Arms the rolling score after each analysis. |

### Choosing a window

This is the one parameter that decides whether the answers are useful. Too short
and every burst of noise is a shape; too long and nothing matches anything. Aim
for **one period of whatever repeats** — one pump cycle, one batch, one traffic
light phase — and remember the analysis needs at least four windows of real
archived data before it will run at all.

## Reading the result

The chart draws three things on one time axis, which is the whole point:

1. the signal, read from the archive by the page;
2. the findings as **bands** — an anomaly and a recurrence both have a duration,
   and a marker at the start of a shape hides the thing that makes it one;
3. the manager's **score curve** underneath with the **threshold** as a dashed
   line — which answers the question the lists cannot: *how close to the line was
   everything else?*

The curve is **live**: the archived period is read once, and every value that
arrives afterwards is appended past its end, with a dotted marker where the
analysis stopped looking. Zooming survives the updates, so you can hold a window
open while the signal keeps coming in.

Clicking a finding highlights its bands rather than zooming to them: an anomaly
that has to be read against the surrounding cycles loses its meaning when the
surrounding cycles are scrolled off-screen.

## The furnace simulator (`furnace_sim_manager.py`)

A second Python manager ships beside the analytics one, so the page has
something real to analyse on a fresh project. On every start (idempotent):

1. creates the `SigSim_Furnace` DP type and `SigSim_Furnace01` when missing;
2. finds the **first active non-alert NGA archive group** (the `EVENT` group by
   preference) and declares value archiving on `temperature` / `power` /
   `gasFlow`;
3. **backfills 6 h of history** (`SIM_BACKFILL_HOURS` overrides) through
   `dp_set_timed_wait` — a restart fills only the gap since it last ran;
4. writes the **injected-anomaly schedule** to `SigSim_Furnace01.info` (JSON);
5. keeps driving the three elements live, one sample every 5 s, on the same
   deterministic time function as the backfill — no seam in the curve.

The simulated process is a batch furnace on a 10-min cycle (ramp → soak → cool →
idle) with two anomaly kinds injected on a **published, phase-locked schedule**:

| Injected | Where it shows | Detectable |
| --- | --- | --- |
| **Overheat** (soak ~18 % hot) | the temperature alone | univariate AND joint |
| **Correlation break** (power collapses mid-ramp, temperature keeps climbing) | no single signal — only the pair | **joint only** |

That schedule is what makes the demo *verifiable*: the tests generate the same
furnace, run the same analysis, and assert both injections are found jointly —
and that the correlation break is NOT found on the temperature alone
(`backend/python/tests/test_furnace_sim.py`).

Configure the demo signal with the three elements
`System1:SigSim_Furnace01.temperature` / `.power` / `.gasFlow`, window ≈ one
cycle (120 samples at the 5 s step).

## Application Security

Three roles, declared in
[`app-security.roles.json`](../../libs/wui-signal-analytics/src/app-security.roles.json)
and open until an admin assigns groups:

| Role | Gates |
| --- | --- |
| `view` | seeing the page at all |
| `configure` | creating, editing and deleting signals (**creates datapoints**) |
| `run` | asking the manager to analyse (**CPU work on the server**) |

Note the honest limitation: the write path is the PARA REST API, so the *server-side*
enforcement on datapoint creation is that route's. The `run` role gates the UI;
a `command` leaf written by any other means is still honoured by the manager —
see [NOTES.md](./NOTES.md#what-is-not-enforced-server-side).

## Contents

```
libs/wui-signal-analytics/
  src/signal-analytics.ts                the page (shell, list, detail, orchestration)
  src/signal-analytics/types.ts          the DP contract, page side
  src/signal-analytics/data/             store (DP I/O + dpConnect), history (dpGetPeriod), demo
  src/signal-analytics/ui/               chart, findings lists, live panel, config dialog
  src/app-security.roles.json            view / configure / run

backend/python/
  signal_analytics_manager.py            entry script (config/progs)
  signal_analytics/protocol.py           the DP contract, manager side
  signal_analytics/service.py            discovery, job queue, DP writes
  signal_analytics/analysis.py           archive read + uniform-grid resampling
  signal_analytics/matrix_profile.py     STOMP / MASS in NumPy
  signal_analytics/realtime.py           the rolling live watch
  signal_analytics/engines/              numpy · stumpy · chronos, and the fallback rule
  tests/                                 runs without WinCC OA
```

## Related

- [NOTES.md](./NOTES.md) — how the detection actually works, and what it cannot do.
- [INTEGRATION.md](./INTEGRATION.md) — deploy, troubleshoot, extend.
- [`docs/knowledge/project/winccoa-python-manager-guide.md`](../knowledge/project/winccoa-python-manager-guide.md)
  — the reusable Python-manager guide this module is the reference implementation of.
