# wui-signal-analytics — integration

Deploying, troubleshooting and extending the page and its Python manager.

## What gets deployed where

| Source | Target | By |
| --- | --- | --- |
| `libs/wui-signal-analytics/` | `<project>/data/dashboard-wc/pages/signal-analytics.js` | `npm run build:pages` |
| `backend/python/**` (minus `tests/`) | `<project>/python/` | `deploy-backend.mjs` |
| — | a line in `<project>/config/progs` | `deploy-backend.mjs` |

```bash
OUT_DIR="<project>/data/dashboard-wc" npm run build:pages
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics
```

The progs line written is:

```
python           | always |      30 |        2 |        2 |signal_analytics_manager.py -num 60
```

`-num` is taken one above the highest already in `progs` (floor 60) because
CTRL, NodeJS and Python managers **share one number space** — a collision shows
up as a manager that starts and dies with a line buried in `PVSS_II.log`.

Preview it without touching anything:

```bash
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics --dry-run --no-build
```

## Then, by hand

1. **Check the interpreter.** WinCC OA ships no CPython. It searches
   `<project>/bin/`, subprojects, the installation, then `PATH`.

   ```bash
   python --version                     # what PATH gives
   python -c "import numpy; print(numpy.__version__)"
   ```

   If that is not the version released for the OS (3.12 on Windows 11 / Server
   2022 / 2025), put the right interpreter — or a link to it — in
   `<project>/bin/`. On this workstation `python` is **3.13** while the released
   one is at `C:\Python\Python312`.

2. **`pip install numpy`** into that interpreter. Optionally `stumpy`, and
   `chronos-forecasting torch` (multi-gigabyte; a model is downloaded from
   Hugging Face on first use, so an air-gapped server needs it pre-seeded in the
   HF cache).

3. **Start `signal_analytics_manager.py`** (and, for the demo,
   **`furnace_sim_manager.py`**) in the WinCC OA console. Nothing
   starts it for you. After a redeploy, **restart** it — a running manager keeps
   executing the code it loaded at startup.

4. **Browser:** F5.

## Deployment dependencies

- **`wui-para`** must be deployed too. The page creates the `SignalAnalysis` DP
  type and its datapoints through `/api/para/dptype/create` and
  `/api/para/dp/create`; `OaRxJsApi` can read and write values but cannot create
  types or datapoints. Without the route the page runs in demonstration mode on
  fabricated findings and says so in a banner.
- **The analysed elements must be archived** — the manager reads
  `:_original.._value` over the period.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every signal shows *"The Python manager has never answered"* | The manager is not running | Start it in the console; check `<project>/log/PVSS_II.log` for its startup line |
| The manager stops immediately | Missing/wrong CPython, or `numpy` absent | `<project>/log/python<num>.log` names it |
| *"no archived numeric value … in the requested period"* | The element has no NGA archive, or the period is empty | Archive it (PARA → Archiving), or widen the history |
| *"a window of N samples needs at least 4N archived values"* | Too little history for the window | Shorten the window or lengthen the period |
| Status stays `queued` forever | The worker is busy with another signal | Analyses are serialised on purpose; wait, or reduce `maxPoints` |
| Ran on `numpy` when `stumpy` was asked for | `stumpy`/Numba would not import | The reason is in the status banner and in `status.fallbackReason` — usually a NumPy version Numba does not accept yet |
| The page shows *demonstration mode* | `/api/para` unreachable, or no write rights | Deploy `wui-para`; restart the webserver manager after a backend deploy |
| The curve is dimmed and labelled *simulated* | `dpGetPeriod` returned nothing for that element | The findings are still real if the manager produced them; the *curve* is a fallback |

**A useful first probe** — write a `ping` command to any configured signal and
watch `status` come back with `"message":"pong"` plus the full engine
availability map. That distinguishes "the manager is down" from "the analysis
fails".

## Extending

### Adding an engine

1. A class in `backend/python/signal_analytics/engines/` with `id`,
   `available() -> (bool, str)` and `analyse(samples, config, progress)`.
2. Register it in `engines/__init__.py`.
3. Add the id to `EngineId` / `ENGINE_IDS` in the page's `types.ts`, and a label
   plus a one-sentence hint in `i18n.ts`.

The `available()` contract is what keeps the page honest: return `False` with a
readable reason rather than raising, and catch more than `ImportError` — an ABI
mismatch surfaces as something else.

### Adding a field to the contract

`protocol.py` and `types.ts` are one contract seen from either end. Change both
in the same commit, and give the field a default on the reading side —
`withDefaults()` on the page, the `_as_*` clamps in `parse_config` on the
manager. Configs written by an older page (and by whoever edits the datapoint in
PARA) keep arriving.

### Bounds are not optional

Everything `parse_config` reads came from a browser. A window of 0 divides by
zero; a history of 400 days reads the archive until PMON kills the manager. Every
field is clamped there, not trusted.

## Application Security

Roles live in
[`libs/wui-signal-analytics/src/app-security.roles.json`](../../libs/wui-signal-analytics/src/app-security.roles.json)
and are registered by the page itself (`registerModuleRoles`) — no central
manifest. `view`, `configure`, `run`; all open until an admin assigns groups, so
declaring them never breaks a deployment.

Server-side enforcement is the `/api/para` route's for datapoint creation. The
manager does not check who wrote a `command` leaf — see
[NOTES.md](./NOTES.md#what-is-not-enforced-server-side) for what that means and
where the extension point is.

## Related

- [README.md](./README.md) — what the page does and how to use it.
- [NOTES.md](./NOTES.md) — how the detection works and what it cannot do.
- [`docs/knowledge/project/winccoa-python-manager-guide.md`](../knowledge/project/winccoa-python-manager-guide.md)
  — writing any Python manager in this repository.
