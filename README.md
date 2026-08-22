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

**Full documentation:**
[docs/wui-signal-analytics/README.md](./docs/wui-signal-analytics/README.md) ·
[INTEGRATION.md](./docs/wui-signal-analytics/INTEGRATION.md) (deploy, troubleshoot, extend) ·
[NOTES.md](./docs/wui-signal-analytics/NOTES.md) (how the detection works, and what it cannot do)

## Contents

| Part | Where | What |
| --- | --- | --- |
| Page | `libs/wui-signal-analytics/` | Lit 3 / Siemens iX web component, route `/signal-analytics` |
| Kit | `libs/wui-kit/` | Shared helpers the page imports (app-security, dialog styles, confirm dialog) |
| Analytics manager | `backend/python/signal_analytics_manager.py` + `signal_analytics/` | The analysis: engines, job queue, live watch, DP protocol |
| Furnace simulator | `backend/python/furnace_sim_manager.py` + `furnace_sim/` | Batch-furnace demo: NGA-archived elements, 6 h backfill, anomalies injected on a published schedule |
| Tests | `backend/python/tests/` | Run without WinCC OA (NumPy only) |
| Module docs | `docs/wui-signal-analytics/` | README, INTEGRATION, NOTES |
| Python-manager guide | `docs/knowledge/project/winccoa-python-manager-guide.md` | Writing any WinCC OA Python manager — this repo is its reference implementation |

There is deliberately **no HTTP route**: WinCC OA's Python API hosts no MSA vRPC
service, so page and manager exchange JSON through one `SignalAnalysis`
datapoint per signal (leaves split by writer, answers pushed by `dpConnect`).
The contract is `libs/.../types.ts` on one side and
`backend/python/signal_analytics/protocol.py` on the other.

## Install into a WinCC OA project

```bash
# frontend (from a wired dev workspace — see DEVELOPMENT.md)
OUT_DIR="<project>/data/dashboard-wc" npm run build:pages

# Python managers (copies backend/python/ → <project>/python/, adds config/progs lines)
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics
```

Then, by hand (see [INTEGRATION.md](./docs/wui-signal-analytics/INTEGRATION.md)):
CPython + `pip install numpy` on the target, start `signal_analytics_manager.py`
(and, for the demo, `furnace_sim_manager.py`) in the WinCC OA console, F5 in the
browser.

**Deployment dependency:** the page creates its datapoints through the
`/api/para` route of `@visuelconcept/wui-para` (from the
[winccoa-wui-pages](https://github.com/visuelconcept/winccoa-wui-pages)
collection). Without it the page opens in demonstration mode and says so.

## Develop

See [DEVELOPMENT.md](./DEVELOPMENT.md) — the runtime shell is scaffolded in
place (`webui-runtime-init`, untracked), then wired to the sources here with
`node tools/wire-workspace.mjs`.

Python tests need no WinCC OA:

```bash
cd backend/python
python -m pytest tests -q          # or: python tests/test_signal_analytics.py
```

## License

AGPL-3.0-only — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) (commercial
license available; WinCC OA, the WebUI Runtime and Siemens iX remain third-party
software under their own licenses).
