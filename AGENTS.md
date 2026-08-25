# WinCC OA Signal Analytics - AI Development Guidelines

> **🧠 Critical Thinking Rules - ALWAYS APPLY**
>
> Read and follow [`docs/knowledge/project/critical-thinking-rules.md`](./docs/knowledge/project/critical-thinking-rules.md) in every session.
> Key points: Don't assume - ask. Verify against official docs, not training data. Evaluate ideas critically. State uncertainty explicitly.

> **Information Hierarchy**
>
> 1. **The WinCC OA skills** — `.ai/skills/winccoa-*/SKILL.md` (standalone page,
>    menu, shared bundles, branding, widgets) and the knowledge base they point
>    at, `docs/knowledge/project/*.md`. This repo follows them; when something
>    here disagrees with them, they win.
> 2. **`README.md`** / **`DEVELOPMENT.md`** - What this repo is, setup, build, deployment
> 3. **`docs/wui-signal-analytics/*.md`** - The module's own docs (README, INTEGRATION, NOTES)
> 4. **`AGENTS.md`** (this file) - Coding standards and quick reference

## Project Overview

**Signal Analytics for WinCC OA WebUI** — one standard standalone page + one
Python manager (+ a furnace simulator), in a standard
`@wincc-oa/webui-runtime` workspace.

- **Domain**: anomaly detection / recurring-shape discovery on SCADA signals
- **Page**: `libs/default-components/src/lib/standalone-pages/signal-analytics.ts`
  (+ `signal-analytics/`) — auto-discovered, menu entry in
  `apps/dashboard-wc/config/menuconfig.jsonc`. Lit 3, TypeScript, RxJS, Siemens
  iX (`@siemens/ix`), tsyringe DI
- **Manager**: CPython + NumPy (STUMPY / Chronos optional), WinCC OA Python API
- **Bridge**: datapoint values only — **no HTTP route, no REST engineering API**.
  One `SignalAnalysis` datapoint per signal, plus one `SignalAnalyticsHub` the
  manager owns because the page cannot create datapoints (`OaRxJsApi` has no
  `dpCreate`). Contract mirrored in
  `standalone-pages/signal-analytics/types.ts` ⇄
  `backend/python/signal_analytics/protocol.py`

## Commands

```bash
# Install (the workspace is versioned — nothing to scaffold, nothing to wire)
npm install --no-audit --no-fund && npm run init:oa-data

npm run start                    # dev server (port 4300); BASE_URL=<oa host> for live data
npx nx lint default-components   # the page's Nx project
npx nx test default-components

# Python tests (no WinCC OA required)
cd backend/python && python -m pytest tests -q

# Deploy to a WinCC OA project
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics
# frontend: OUT_DIR="<project>/data/dashboard-wc" npm run build:pages

# Upgrade the runtime (re-scaffold over the workspace, then review the diff)
npm install @wincc-oa/webui-runtime@latest && npx webui-runtime-init
git checkout -- README.md AGENTS.md CLAUDE.md LICENSE .gitignore   # the scaffold overwrites these
```

## Boundaries

### Always Do

- **Before modifying the module, re-read its own docs first** —
  `docs/wui-signal-analytics/{README,NOTES,INTEGRATION}.md` and the
  source-header comment blocks. They record the DP contract, runtime coupling
  and caveats the code alone does not surface.
- **The DP contract is one contract seen from two ends.** Change `types.ts` and
  `protocol.py` in the same commit; give new fields a default on the reading
  side (`withDefaults()` page-side, the `_as_*` clamps in `parse_config`
  manager-side).
- **Bounds are not optional.** Everything `parse_config` reads came from a
  browser — clamp every field.
- **Permissions are the runtime's own, never a custom model** — page visibility
  through the `permission` field of the menu entry, *Configure* on `canEdit`,
  *Analyse* on `canWrite`, all read from `WuiUserService` in
  `standalone-pages/signal-analytics/data/permissions.ts`.
- **The page never engineers a datapoint.** Creating or deleting one goes through
  `SignalAnalyticsHub.request` and is executed by
  `backend/python/signal_analytics/provision.py`; the manager refuses any name
  outside its own `SigAnalysis_` prefix. A new hub operation means a new branch
  there *and* in `parse_hub_request`, in the same commit.
- Use iX components and CSS custom properties; Shadow DOM for WebComponents
- For `@wincc-oa/*` API questions, read the installed
  `node_modules/@wincc-oa/<lib>/README.md` first (exception:
  `@etm-professional-control/oa-rx-js-api`)
- New analysis engine: class in `backend/python/signal_analytics/engines/` with
  `id`, `available() -> (bool, str)`, `analyse(...)`; register in
  `engines/__init__.py`; add the id to `EngineId`/`ENGINE_IDS` in `types.ts` and
  a label in `i18n.ts`. `available()` returns `False` with a readable reason
  rather than raising.

### Never Do

- Override iX component shadow DOM internals
- Hardcode colors, spacing, or theme values
- Commit secrets, credentials, or `.env` files
- Use `any` type without justification
- Patch the runtime shell. The workspace is standard and stays standard: no
  edits to `apps/dashboard-wc/vite*.ts`, `libs/default-components/src/lib/`
  (outside `standalone-pages/signal-analytics*`), `tsconfig.base.json` or
  `package.json`. A page needs none of it — dropping the `.ts` in
  `standalone-pages/` and adding a `menuconfig.jsonc` entry is the whole
  integration
- Ship compiled Python bytecode (`__pycache__`) or tests to a project

## Documentation

- [docs/wui-signal-analytics/README.md](./docs/wui-signal-analytics/README.md) — what the page does, engines, furnace simulator
- [docs/wui-signal-analytics/INTEGRATION.md](./docs/wui-signal-analytics/INTEGRATION.md) — deploy, troubleshoot, extend
- [docs/wui-signal-analytics/NOTES.md](./docs/wui-signal-analytics/NOTES.md) — how the detection works, and what it cannot do
- [docs/knowledge/project/winccoa-python-manager-guide.md](./docs/knowledge/project/winccoa-python-manager-guide.md) — writing, deploying and debugging a WinCC OA **Python** manager; this repo is the reference implementation
- [Siemens iX documentation](https://ix.siemens.io/) · [Lit documentation](https://lit.dev/docs/)
- `docs/knowledge/project/webui-runtime-standalone-page-guide.md` — the pattern
  this page follows; also `webui-runtime-shared-bundles.md`,
  `coding-conventions.md`, `webserver-api-reference.md` (what the standard
  webserver does and does not expose)
- `.ai/skills/winccoa-*/SKILL.md` — the WinCC OA skills: standalone page, menu,
  shared bundles, branding, widgets
