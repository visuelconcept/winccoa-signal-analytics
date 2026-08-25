# WinCC OA Python Manager — guide

Everything needed to write, deploy and debug a **Python manager** in this
repository. Read it before touching anything under `backend/python/`.

**Sources.** The API facts below were read from the installed documentation and
sources, not from memory:

- `C:\Siemens\Automation\WinCC_OA\3.21\api.python\docs\markdown\` —
  `getting-started.md`, `installation.md`, `guide/manager.md`,
  `guide/data-access.md`, `guide/datatypes.md`, `guide/ctrl-interoperation.md`
  (the same content as `qthelp://winccoa_3.21_core_en/doc/python_api/…`, in a form
  you can grep). The HTML build sits next to it in `docs/html/`.
- `C:\Siemens\Automation\WinCC_OA\3.21\python\libs\etm\wccoa\` — the runtime
  packages themselves. `services/protocols/scripting_api.py` is the **complete,
  authoritative signature list**; when this guide and that file disagree, the
  file wins.

Verify against those paths on the machine you are working on. The `api.python`
tree only exists where the **APIPython** setup component was installed.

---

## 1. What a Python manager is, and is not

A Python manager is a `python.exe` process that PMON starts like any other
manager. It connects to the Event and Data managers through a native extension
and can read, write, subscribe and query — the same surface a CTRL or JavaScript
manager has.

What it is **not**, and this decides architectures:

- **It hosts no MSA vRPC service.** The backends of the `winccoa-wui-pages`
  collection (`processMonitor`, `dplAscii`, `rtspProxy`, …) are *JavaScript*
  managers that publish a vRPC service which a webserver route calls over HTTP.
  There is no Python equivalent in 3.21. A page cannot reach a Python manager
  through `/api/<module>/…`.
- **It is not started by this repository.** Deploying copies files; a human
  starts the manager in the WinCC OA console.

**So how does a page talk to Python?** Through datapoints. Give the module a DP
type whose leaves are split by writer — the page writes the request leaves, the
manager writes the answer leaves — and let `dpConnect` carry the changes both
ways. `libs/default-components/src/lib/standalone-pages/signal-analytics*` +
`backend/python/signal_analytics/` is the worked example; its contract is
`protocol.py` on one side and `types.ts` on the other. Three rules make it safe:

- **No leaf is written by both sides.** Otherwise a slow write races an answer.
- **Every request carries a `requestId`** the manager echoes, so the page can
  tell this run's answers from the ones still sitting on the leaves.
- **The manager engineers, the page never does.** `OaRxJsApi` has no `dpCreate`
  and the standard webserver exposes no engineering route, so a page that needs
  datapoints must ask for them: give the module one hub datapoint the manager
  creates on start (`dp_type_create` / `dp_create`, see
  `signal_analytics/provision.py`), have the page write requests on it, and fence
  the manager to its own name prefix so a request can never reach an unrelated
  datapoint. The hub's existence is also the page's liveness probe: no hub, no
  manager.

---

## 2. Prerequisites on the machine

| Requirement | Detail |
|---|---|
| Setup component `PythonEnv` | Ships `_etm_wccoa_manager_scripting` into `<OA>/bin/` and the `etm.wccoa` packages into `<OA>/python/libs/`. Required on **every machine that runs a Python manager**. |
| Setup component `APIPython` | Wheels, examples and the docs above. Engineering stations only; adds nothing at runtime. |
| CPython | **Not shipped by WinCC OA.** One version is released per OS — 3.12 on Windows 11 / Server 2022 / Server 2025, 3.12 on RHEL 10, 3.13 on Debian 13, 3.11 on Debian 12 and Industrial OS 4. |

WinCC OA looks for `python` in the `bin/` directories of the project, its
subprojects and the installation, then on `PATH`.

> **The trap on a developer machine.** Several Pythons on `PATH` means the
> manager silently runs on whichever is first — not necessarily the released one.
> On this workstation, `python` resolves to **3.13** while WinCC OA's released
> version is the **3.12** at `C:\Python\Python312`. Pin it by putting the
> interpreter (or a link to it) in `<project>/bin/`, and use that same
> interpreter for local test runs.

Extra packages (`numpy`, `stumpy`, …) are installed with `pip` into that
interpreter's environment. `PYTHONPATH` and `WCCOA_BIN_DIRS` are set by PMON —
never set them yourself.

---

## 3. Layout and deployment in this repository

```
backend/python/
├── <manager>_manager.py         entry script, registered in config/progs
├── <manager>/                   the package it imports
│   ├── __init__.py
│   ├── protocol.py              the DP contract, mirrored in the page's types.ts
│   └── …
└── tests/                       pytest-style, NOT deployed
```

Declare the entry script in `tools/specs.json`:

```jsonc
{
  "page": "signal-analytics",
  "backend": { "pythonManagers": ["signal_analytics_manager.py"] }
}
```

`tools/scripts/deploy-backend.mjs` then mirrors **the whole `backend/python/`
tree** into `<project>/python/` (minus `tests/` and `__pycache__/`) and appends a
line to `config/progs`:

```
python           | always |      30 |        2 |        2 |signal_analytics_manager.py -num 60
```

Three things about that line:

- the manager keyword is **`python`**, and the options field is
  `<script>.py -num <n>` — interpreter options, if any, go *before* the script
  name; `-PROJ` and `-pmonIndex` are added by PMON and must not be written here;
- `-num` is unique across **all** scripting managers (CTRL, NodeJS, Python share
  one number space). The deploy script reads every `-num` already in `progs` and
  goes one above the highest, with a floor of 60;
- the whole tree is copied because PMON resolves only the *script name* in
  `<project>/python/`; the package next to it is found because CPython puts the
  script's directory on `sys.path`.

The deploy script **never starts or restarts a manager** — that is a live-system
action and belongs in the console.

---

## 4. The shape of a manager

```python
import logging, os, sys, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from etm.wccoa.manager import Manager
from my_module.service import Service

logger = logging.getLogger("my_module")

def main() -> None:
    with Manager() as manager:          # start() on enter, stop() on exit
        service = Service(manager)
        service.start()
        try:
            threading.Event().wait()    # ends on SIGTERM from PMON
        finally:
            service.stop()

if __name__ == "__main__":
    main()
```

- `Manager()` is a **singleton** per process and takes no arguments — project,
  `-num` and `-pmonIndex` come from the command line.
- The `with` block is the recommended lifecycle; it is the only form that
  guarantees a clean shutdown through an exception.
- A manager that only subscribes **must block explicitly**, otherwise it leaves
  the `with` block, stops, and no callback ever arrives.
- `start()` installs SIGINT/SIGTERM handlers that stop the manager and raise
  `SystemExit`, so `finally` blocks still run. PMON stops managers with SIGTERM.

### Threads

| Thread | Created by | Runs |
|---|---|---|
| Script thread, and any you start | your code | your code |
| Event-loop thread | `start()` | runtime communication (internal — calling the API on it raises `RuntimeError`) |
| Callback pool threads | `start()` | your subscription callbacks |

Every API method is thread-safe and may be called from a callback, including
`dp_set` inside a `dp_connect` callback.

**Do the work off the callback thread.** A callback that computes for two seconds
blocks a pool thread. The pattern used here: the callback parses and pushes a job
onto a `queue.Queue`; one worker thread drains it. Serialising CPU-bound work is
deliberate — a SCADA server's cores belong to the plant.

---

## 5. Data access — the parts that bite

**Address an element, never a datapoint.** `dp_get("System1:Dp.")` works,
`dp_get("System1:Dp")` raises `OaErrorException`. Config and attribute are
completed implicitly, and **differently by direction**: reads and subscriptions
complete to `:_online.._value`, writes to `:_original.._value`.

| Need | Call |
|---|---|
| Value from the process image | `dp_get(dpe)` / `dp_get([dpe, …])` |
| Value from the device | `dp_get_max_age(age_ms, dpe)`, `dp_direct_read(dpe)` |
| Write and wait | `dp_set_wait(dpe, value)` — use for anything that matters |
| Write and forget | `dp_set(dpe, value)` — cyclic measurements only; **errors found by the event manager never reach you** |
| Write with a source time | `dp_set_timed_wait(when, dpe, value)` |
| Write, then wait for a condition | `dp_set_and_wait_for_value(...)` (timeout → `OaErrorException`, error_id 54) |
| Subscribe | `dp_connect(callback, dpes, answer=True)` → connect id; `dp_disconnect(id)` |
| Subscribe to a query | `dp_query_connect_single` / `…_all`, `blocking_time_ms` to rate-limit |
| Many elements at once | `dp_query("SELECT '_online.._value' FROM 'Pattern*'")` |
| History | `dp_get_period(start, end, dpes, count=0)` |
| History, large | `dp_get_period_split(...)` — loop until `chunk.progress == 100` |
| Alert history | `alert_get_period(start, end, dpes)` |
| **Engineering** (what a page cannot do) | `dp_type_create(definition)` / `dp_type_get` / `dp_types(pattern)`, `dp_create(name, type)`, `dp_delete(name)`, `dp_exists(dpe)` |

The engineering calls are the reason a Python manager can back a page that needs
datapoints of its own: the WebUI runtime API has none of them. `definition` is an
``OaDpTypeDefinition`` tree (`from etm.wccoa.services.data import
OaDpTypeDefinition, OaElementType`) — a STRUCTURE root plus one `add_leaf(name,
OaElementType.STRING)` per leaf. Import it **lazily**, inside the function that
creates the type, so the module stays importable (and testable) without a WinCC
OA installation. `signal_analytics/provision.py` and `furnace_sim/provision.py`
are both worked examples; make every path idempotent, because the manager runs it
on every start.

### Callback arguments

`dp_connect` delivers **one** argument with `.error`, `.is_answer`,
`.is_refresh` and `.values` — a tuple of `OaDpValueItem` (`dp_path`,
`dp_identifier`, `dp_value`). **Check `.error` first**: on error `.values` is
`None`.

Two consequences worth planning for:

- **`answer=True` replays the current value immediately.** A manager restart
  therefore re-delivers whatever command was last left on a request leaf. Guard
  against re-executing it — compare the `requestId`, and treat the `is_answer`
  callback as "adopt the current state", not "act on it".
- **No source timestamp.** `OaDpValueItem` carries the value, not its `_stime`.
  Use arrival time, or read `:_online.._stime` explicitly when it matters.

### Values are `OaVariant`

Unwrap with `.value`. Historical items (`OaDpTimedValueItem`) carry
`source_time` (a `datetime`) and `dp_value`. Write defensively — a
`getattr(value, "value", value)` accessor keeps the manager alive when a leaf
holds something unexpected.

### Historical data is event-based

Archived values land when they change, not on a clock. Any algorithm that counts
in *samples* — a window, a forecast horizon, an FFT — must resample onto a
uniform grid first, or its window covers four seconds in one place and four hours
in another. `backend/python/signal_analytics/analysis.py` does this and reports
the resulting step back to the page.

---

## 6. Logging

Use the standard `logging` module — records are forwarded to the WinCC OA log
system.

| Level | Lands in |
|---|---|
| `INFO` and above | `<project>/log/PVSS_II.log` (with every other manager) |
| `DEBUG` | `<project>/log/python<num>.log` |
| `print()` | `<project>/log/python<num>.log`, unformatted — not a log record |

If a manager stops immediately after starting, that log file is the first place
to look.

---

## 7. Testing without a project

The API is only reachable inside a manager process, so **do not put it in the
code under test**. Keep the algorithms in modules that take plain arrays, and
test the service layer against a fake:

```python
class FakeManager:
    """The slice of the scripting API the service actually uses."""
    def dp_names(self, pattern="", dp_type=""): ...
    def dp_connect(self, callback, dpes, answer=True): ...
    def dp_set_wait(self, dpe, value): ...
    def dp_get_period_split(self, start_or_id, end=None, dpes=None, count=0): ...
```

`backend/python/tests/test_signal_analytics.py` is the working example: it runs
the real service end to end against a fake manager, and it runs with or without
pytest:

```bash
cd backend/python
"C:/Python/Python312/python.exe" -m pytest tests -q
"C:/Python/Python312/python.exe" tests/test_signal_analytics.py
```

Where a synthetic input has a known answer — a repeated cycle with one shape
replaced has exactly one anomaly and one motif — assert on the answer, not on the
absence of an exception.

To run a script against a *live* project by hand, supply the options and the
environment PMON would have set; see `development-setup.md` in the installed
docs.

---

## 8. Optional third-party packages

Anything beyond the standard library and what is already installed is a
deliberate act on the server. Treat it as such:

- **Import it lazily, inside the code that needs it**, so the manager starts even
  when it is absent.
- **Report availability rather than crashing.** The engine registry pattern
  (`backend/python/signal_analytics/engines/__init__.py`) returns
  `(usable, reason)` per back-end, falls back to one that is always present, and
  publishes the whole availability map on every status write — so the page can
  say *"ran on numpy — stumpy is not installed"* instead of showing an error.
- **Catch more than `ImportError`.** A package built against a different NumPy
  (Numba is the usual culprit) raises at import time with something else
  entirely.

---

## 9. Checklist for a new Python manager

1. `backend/python/<name>_manager.py` + `backend/python/<name>/` package.
2. A DP contract module, mirrored in the page's `types.ts`, with the leaves split
   by writer.
3. Callbacks that only parse and enqueue; a worker thread that does the work.
4. Bounds on every value parsed out of JSON — it came from a browser.
5. Errors written to the status leaf, not only logged.
6. `tools/specs.json`: `backend.pythonManagers`.
7. Tests against a `FakeManager`, run with the released CPython.
8. Permissions for anything the page can trigger: the runtime's own flags
   (`canEdit` / `canWrite` from `WuiUserService`) plus the `permission` field of
   the menu entry — and remember the Event manager enforces `canWrite` on the
   write itself, which is the only enforcement a manager gets for free.
9. Tell whoever deploys: **start the manager in the console**, nothing does it
   for them.

---

## Related

- [`docs/wui-signal-analytics/`](../../wui-signal-analytics/README.md) — the
  reference implementation of this pattern.
- [`webserver-api-reference.md`](./webserver-api-reference.md) — the HTTP/vRPC
  route, for the JavaScript-manager case this guide does *not* cover.
- [`webui-runtime-standalone-page-guide.md`](./webui-runtime-standalone-page-guide.md)
  — the page half.
