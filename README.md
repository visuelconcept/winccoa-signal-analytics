# WinCC OA Signal Analytics — `@visuelconcept/wui-signal-analytics`

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Anomaly detection and recurring-shape discovery on WinCC OA process signals:
a **standalone page** for the WinCC OA
[WebUI Runtime](https://www.winccoa.com/documentation/WinCCOA/latest/en_US/WebUIRuntime/topics/WebUIRuntime_Basics.html)
dashboard, backed by a **WinCC OA Python manager**.

Pick the datapoint elements worth watching, and the manager tells you two things
about each of them:

- **anomalies** — the stretches of signal that resemble nothing else in the
  period, ranked, with a duration and a severity;
- **recurrences** — the shapes that keep coming back, with every occurrence and
  the median cycle time between them.

A signal names one or several elements — several mean ONE **joint analysis**
(mSTAMP): anomalies that only exist in the *correlation* between signals become
detectable. First over the **archived history**, then **continuously on the live
values**. Three engines, chosen per signal: matrix profile (built-in NumPy),
STUMPY, or Chronos forecasting — an engine that is not installed never fails a
run, the manager falls back and says so.

![The Signal Analytics page: a joint analysis over three furnace elements, four
anomalies and four recurrences found on a 6 h 42 min archived period](./docs/images/manual/signal-analytics.png)

*A joint (mSTAMP) analysis over `SigSim_Furnace01.gasFlow` / `.power` /
`.temperature` — 4 814 points on a 5 s grid, window 128 samples ≈ 10 min 41 s,
run by STUMPY in 21 s. The four shaded stretches are the anomalies; the score
curve and its threshold are on the right axis.*

**Full documentation:**
[docs/wui-signal-analytics/README.md](./docs/wui-signal-analytics/README.md) ·
[INTEGRATION.md](./docs/wui-signal-analytics/INTEGRATION.md) (deploy, troubleshoot, extend) ·
[NOTES.md](./docs/wui-signal-analytics/NOTES.md) (how the detection works, and what it cannot do)

## Contents

| Part | Where | What |
| --- | --- | --- |
| Page | `libs/default-components/src/lib/standalone-pages/signal-analytics.ts` (+ `signal-analytics/`) | Standard WebUI standalone page: Lit 3 / Siemens iX, route `/signal-analytics` |
| Analytics manager | `backend/python/signal_analytics_manager.py` + `signal_analytics/` | The analysis: engines, job queue, live watch, DP protocol |
| Furnace simulator | `backend/python/furnace_sim_manager.py` + `furnace_sim/` | Batch-furnace demo: NGA-archived elements, 6 h backfill, anomalies injected on a published schedule |
| Tests | `backend/python/tests/` | Run without WinCC OA (NumPy only) |
| Module docs | `docs/wui-signal-analytics/` | README, INTEGRATION, NOTES |
| Python-manager guide | `docs/knowledge/project/winccoa-python-manager-guide.md` | Writing any WinCC OA Python manager — this repo is its reference implementation |

There is deliberately **no HTTP route and no REST engineering API**: WinCC OA's
Python API hosts no MSA vRPC service, and the WebUI runtime API
(`OaRxJsApi`) has no `dpCreate`. So everything travels over datapoint values —
one `SignalAnalysis` datapoint per signal, leaves split by writer, answers pushed
by `dpConnect` — and the datapoints themselves are **created by the manager**,
which the page asks over one hub datapoint (`SignalAnalyticsHub`). The contract is
`…/standalone-pages/signal-analytics/types.ts` on one side and
`backend/python/signal_analytics/protocol.py` on the other.

No manager running means no hub, which is exactly when the page says it is in
demonstration mode.

## Prerequisite: install the workspace

This repo **is** a `@wincc-oa/webui-runtime` workspace: the runtime shell, the
npm scripts and the Vite configs are versioned here, and the page sits where the
runtime discovers it by itself. A clone therefore needs nothing scaffolded and
nothing wired:

```bash
npm install --no-audit --no-fund
npm run init:oa-data              # local oa-data/ tree served in dev
```

Both `npm run build:pages` and `npm start` come from that install — the backend
deploy below does not (plain node).

To move to a newer runtime, re-scaffold over the workspace and merge; the
commands and what to watch for are in [DEVELOPMENT.md](./DEVELOPMENT.md):

```bash
npm install @wincc-oa/webui-runtime@latest
npx webui-runtime-init            # overwrites the scaffolded files — then review `git diff`
npm install --save-dev --no-audit --no-fund
npm run init:oa-data
```

⚠️ `webui-runtime-init` also overwrites `README.md`, `AGENTS.md`, `CLAUDE.md`,
`LICENSE` and `.gitignore`. Restore ours right after:
`git checkout -- README.md AGENTS.md CLAUDE.md LICENSE .gitignore docs/knowledge/project/critical-thinking-rules.md`.

## Install into a WinCC OA project

```bash
# frontend — needs `npm install` above (the npm script and Vite config live here)
OUT_DIR="<project>/data/dashboard-wc" npm run build:pages

# Python managers — plain node, no workspace needed
# (copies backend/python/ → <project>/python/, adds the config/progs lines)
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics
#   --dry-run   print what would happen, change nothing
#   --no-progs  copy the managers but leave config/progs alone
```

Then, by hand (see [INTEGRATION.md](./docs/wui-signal-analytics/INTEGRATION.md)):
CPython + `pip install numpy` on the target, start `signal_analytics_manager.py`
(and, for the demo, `furnace_sim_manager.py`) in the WinCC OA console, F5 in the
browser.

**No other module is required.** The manager creates its own DP types and its own
hub datapoint on first start; the standard WinCC OA webserver (`webserver/run.js`)
serves everything the page needs. Until that manager has run once, the page opens
in demonstration mode and says so.

**Permissions.** The menu entry requires a connected user; *Configure* needs
`canEdit` and *Analyse* needs `canWrite` — the runtime's own flags, so a
read-only user sees the findings and cannot change or launch anything.

## Develop

`BASE_URL=https://<oa-host>:<httpsPort> npm start` → https://127.0.0.1:4300.
Editing `libs/default-components/src/lib/standalone-pages/signal-analytics*`
hot-reloads. Full workflow, runtime upgrade and troubleshooting:
[DEVELOPMENT.md](./DEVELOPMENT.md).

Python tests need no WinCC OA:

```bash
cd backend/python
python -m pytest tests -q          # or: python tests/test_signal_analytics.py
```

## License

AGPL-3.0-only — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) (commercial
license available; WinCC OA, the WebUI Runtime and Siemens iX remain third-party
software under their own licenses).
