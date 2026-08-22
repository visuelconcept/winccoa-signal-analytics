# `backend/python/` — WinCC OA Python managers

Python managers deployed into a WinCC OA project's `python/` directory — the
whole backend of this module (there is no JavaScript manager and no webserver
route here; the page reaches Python through datapoints).

**Read [`docs/knowledge/project/winccoa-python-manager-guide.md`](../../docs/knowledge/project/winccoa-python-manager-guide.md)
before adding or changing anything here.** It covers the lifecycle, the threading
model, the data-access calls, and the one architectural fact that shapes every
module in this directory: **a Python manager hosts no MSA vRPC service**, so a
page reaches it through datapoints, never through an HTTP route.

## Layout

```
<name>_manager.py     the entry script, named in tools/specs.json and config/progs
<name>/               the package it imports (sits beside it on sys.path)
tests/                pytest-style; NOT deployed
```

## Deployment

Declared per page in `tools/specs.json`:

```jsonc
{ "page": "signal-analytics", "backend": { "pythonManagers": ["signal_analytics_manager.py"] } }
```

`tools/scripts/deploy-backend.mjs` mirrors this whole tree (minus `tests/` and
`__pycache__/`) into `<project>/python/` and appends a `progs` line with a `-num`
one above the highest already there. It **never starts a manager** — a human does
that in the WinCC OA console.

## Running the tests

Use the CPython version **released for the OS** (3.12 on Windows here — not
whatever `python` resolves to on a developer box):

```bash
cd backend/python
"C:/Python/Python312/python.exe" -m pytest tests -q
"C:/Python/Python312/python.exe" tests/test_signal_analytics.py   # no pytest needed
```

The tests never import `etm.wccoa`: the algorithms take plain arrays, and the
service layer runs against a `FakeManager` that records datapoint writes.

## Modules

| Entry script | Page | What it does |
| --- | --- | --- |
| `signal_analytics_manager.py` | `/signal-analytics` | Anomaly and recurrence detection on archived and live signals — matrix profile (NumPy or STUMPY, joint/multivariate via mSTAMP) or Chronos forecasting. See [`docs/wui-signal-analytics/`](../../docs/wui-signal-analytics/README.md). |
| `furnace_sim_manager.py` | `/signal-analytics` (demo) | Batch-furnace simulator: provisions three NGA-archived elements (temperature/power/gasFlow), backfills 6 h of history and drives them live, with anomalies injected on a published schedule — including a correlation break only a joint analysis can find. |

## Dependencies

`numpy` is required. Everything beyond it is optional, imported lazily and
reported as unavailable rather than crashing the manager — see the engine
registry in `signal_analytics/engines/__init__.py` for the pattern to copy.

```bash
pip install numpy                          # required
pip install stumpy                         # optional: faster matrix profile
pip install chronos-forecasting torch      # optional: forecasting engine (multi-GB)
```
