# Development

This repo is a **standard `@wincc-oa/webui-runtime` workspace**. The runtime
shell, the npm scripts, the Vite configs and the Nx projects are versioned here,
and the Signal Analytics page lives where the runtime discovers pages by itself:

```
libs/default-components/src/lib/standalone-pages/
  signal-analytics.ts        the page (auto-discovered at build time -> pages/signal-analytics.js)
  signal-analytics/          its sub-components, data layer, i18n, DP contract
```

Nothing is wired, patched or generated to make that work — dropping a `.ts` file
in `standalone-pages/` is the whole mechanism (see
`docs/knowledge/project/webui-runtime-standalone-page-guide.md`, and the
`winccoa-standalone-page` skill under `.ai/skills/`).

## 1. Install (once, in the repo root)

```bash
npm install --no-audit --no-fund
npm run init:oa-data          # provisions the local oa-data/ tree served in dev
```

## 2. Develop the page (HMR)

All live data comes from a running WinCC OA, proxied to `BASE_URL`:

```powershell
# Windows (PowerShell)
$env:BASE_URL="https://<oa-host>:<httpsPort>"; npm start   # https://127.0.0.1:4300
```

```bash
# Linux / macOS
BASE_URL=https://<oa-host>:<httpsPort> npm start
```

Edit `libs/default-components/src/lib/standalone-pages/signal-analytics*` → hot
reload. For real analyses the OA target must run `signal_analytics_manager.py`;
without it the page runs in demonstration mode and says so (no manager, no hub
datapoint — see §5).

Lint and unit-test the page through its own Nx project:

```bash
npx nx lint default-components
npx nx test default-components
```

## 3. Develop the Python managers

No WinCC OA needed for the analysis code — everything below the `Manager` API is
plain NumPy and tested against synthetic signals (the provisioning is tested
against a fake engineering manager, so the DP-type shapes are covered too):

```bash
cd backend/python
python -m pytest tests -q               # with pytest
python tests/test_signal_analytics.py   # without
python tests/test_furnace_sim.py
```

Against a real project, deploy + restart the manager (a running manager keeps
executing the code it loaded at startup):

```bash
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics
# preview: … --dry-run --no-build
```

`deploy-backend.mjs` uses node built-ins only — it needs no workspace install.
Manager logs: `<project>/log/python<num>.log`; startup line in
`<project>/log/PVSS_II.log`.

## 4. Build & deploy the page

```powershell
$env:OUT_DIR="<project>/data/dashboard-wc"; npm run build:pages
```

⚠️ **Build on the target's runtime workspace version**: a page bundle is coupled
to the shell's import map. `build:pages` also re-copies `menuconfig.jsonc` →
`menuconfig.json`, so re-run it after editing the menu (the page's entry lives in
`apps/dashboard-wc/config/menuconfig.jsonc` like every other entry).

## 5. The datapoints, and who creates them

The page reads and writes datapoint **values** only — `dpGet`, `dpNames`,
`dpConnect`, `dpSet`. It cannot create a datapoint: `OaRxJsApi` has no
`dpCreate`, and the standard webserver exposes no engineering route. So:

| Who | Does |
|---|---|
| `signal_analytics_manager.py` on start | creates the DP types `SignalAnalysis` and `SignalAnalyticsHub`, creates the hub datapoint, writes its `info` leaf |
| the page, to add or drop a signal | writes a request on `SignalAnalyticsHub.request`, waits for the answer on `.response` |
| the manager | creates / deletes `SigAnalysis_<id>` and answers |
| the page, to edit a signal | plain `dpSet` on the leaves it owns (`name`, `config`, `command`) |

Consequences worth knowing:

- **A project where the manager never ran has no hub**, so the page opens in
  demonstration mode. That is the intended signal, not a bug.
- **The manager needs engineering rights** in the project it runs in. Without
  them provisioning fails, the failure is logged, and the analysis service still
  starts — the page just keeps saying "no manager".
- The manager only ever deletes datapoints under its own `SigAnalysis_` prefix;
  anything else on a `delete` request is refused with a readable reason.

## 6. Permissions

The runtime's own model, nothing custom:

- **page visibility** — the `permission` field of the menu entry
  (`["connected"]`);
- **Configure** (create / edit / delete a signal) — `canEdit`;
- **Analyse** (write the `command` leaf) — `canWrite`, the same flag the Event
  manager enforces on the write itself.

Both flags are read from `WuiUserService` in
`standalone-pages/signal-analytics/data/permissions.ts`.

## 7. Upgrading the runtime

The workspace is tracked, so an upgrade is a re-scaffold **over** it followed by
a review of the diff — not a re-wire:

```bash
npm install @wincc-oa/webui-runtime@latest    # or a pinned version
npx webui-runtime-init                        # overwrites the scaffolded files
npm install --save-dev --no-audit --no-fund
npm run init:oa-data
git checkout -- README.md AGENTS.md CLAUDE.md LICENSE .gitignore \
                docs/knowledge/project/critical-thinking-rules.md
git status --short && git diff                # review what the new runtime changed
```

Two things the re-scaffold overwrites and that must be put back by hand:

1. the Signal Analytics entry in `apps/dashboard-wc/config/menuconfig.jsonc`;
2. anything else `git diff` shows under `apps/` or `libs/default-components/`
   that you recognise as ours.

`webui-runtime-init` does **not** touch `standalone-pages/signal-analytics*`,
`backend/`, `docs/wui-signal-analytics/` or `tools/scripts/deploy-backend.mjs`.

## Layout

```
apps/dashboard-wc/            the shell app, its Vite configs and its config/*.jsonc
libs/default-components/      the runtime's components + our standalone page
backend/python/               the two managers + their packages + tests
docs/wui-signal-analytics/    module docs (README, INTEGRATION, NOTES)
docs/knowledge/project/       runtime knowledge base + the Python-manager guide
tools/scripts/                deploy-backend.mjs (ours) + the runtime's oa-data scripts
tools/specs.json              what deploy-backend.mjs copies to a project
```
