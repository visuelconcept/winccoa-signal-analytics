# WinCC OA Signal Analytics - AI Development Guidelines

> **🧠 Critical Thinking Rules - ALWAYS APPLY**
>
> Read and follow [`docs/knowledge/project/critical-thinking-rules.md`](./docs/knowledge/project/critical-thinking-rules.md) in every session.
> Key points: Don't assume - ask. Verify against official docs, not training data. Evaluate ideas critically. State uncertainty explicitly.

> **Information Hierarchy**
>
> 1. **`README.md`** / **`DEVELOPMENT.md`** - What this repo is, setup, build, deployment
> 2. **`docs/wui-signal-analytics/*.md`** - The module's own docs (README, INTEGRATION, NOTES)
> 3. **`AGENTS.md`** (this file) - Coding standards and quick reference

## Project Overview

**Signal Analytics for WinCC OA WebUI** — one standalone page + one Python
manager (+ a furnace simulator), extracted from the `winccoa-wui-pages`
incubation repo into its own module repo.

- **Domain**: anomaly detection / recurring-shape discovery on SCADA signals
- **Page**: Lit 3 WebComponents, TypeScript, RxJS, Siemens iX (`@siemens/ix`), tsyringe DI
- **Manager**: CPython + NumPy (STUMPY / Chronos optional), WinCC OA Python API
- **Bridge**: one `SignalAnalysis` datapoint per signal — **no HTTP route** (the
  Python API hosts no MSA vRPC service); contract mirrored in
  `libs/.../signal-analytics/types.ts` ⇄ `backend/python/signal_analytics/protocol.py`

## Commands

```bash
# Dev workspace (scaffolded in place, untracked — see DEVELOPMENT.md)
npm run start                    # dev server (port 4300), after wire-workspace

# Python tests (no WinCC OA required)
cd backend/python && python -m pytest tests -q

# Deploy to a WinCC OA project
node tools/scripts/deploy-backend.mjs --project "<project>" --only signal-analytics
# frontend: OUT_DIR="<project>/data/dashboard-wc" npm run build:pages
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
- **Application Security roles are part of every capability change** — roles in
  `libs/wui-signal-analytics/src/app-security.roles.json` (`view` / `configure`
  / `run`), gated with `hasRole$`. Never rename a role id silently.
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
- Edit the scaffolded workspace files (`apps/`, `tsconfig.base.json`,
  `package.json`, `libs/default-components/`) directly — patch them through
  `tools/wire-workspace.mjs` so a re-scaffold reproduces the change
- Ship compiled Python bytecode (`__pycache__`) or tests to a project

## Documentation

- [docs/wui-signal-analytics/README.md](./docs/wui-signal-analytics/README.md) — what the page does, engines, furnace simulator
- [docs/wui-signal-analytics/INTEGRATION.md](./docs/wui-signal-analytics/INTEGRATION.md) — deploy, troubleshoot, extend
- [docs/wui-signal-analytics/NOTES.md](./docs/wui-signal-analytics/NOTES.md) — how the detection works, and what it cannot do
- [docs/knowledge/project/winccoa-python-manager-guide.md](./docs/knowledge/project/winccoa-python-manager-guide.md) — writing, deploying and debugging a WinCC OA **Python** manager; this repo is the reference implementation
- [Siemens iX documentation](https://ix.siemens.io/) · [Lit documentation](https://lit.dev/docs/)
- After scaffolding, the runtime's own knowledge base appears under
  `docs/knowledge/` (untracked): standalone-page guide, shared bundles, coding
  conventions…
