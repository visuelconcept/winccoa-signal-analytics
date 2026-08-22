# Signal Analytics — Anomaly Detection with the WinCC OA Python Manager

*What we built with the new Python Manager beta, what it changed for us, and the
traps we hit so you don't have to.*

---

With version 3.21, WinCC OA ships something many of us have been waiting for: a
**native Python Manager**, currently in beta. A Python script registered in the
console like any CTRL or Node.js manager — started, stopped and monitored by
PMON — with full access to datapoints, subscriptions, queries and the archive.

We didn't want to judge it on a hello-world. So we built a real feature on it:
**Signal Analytics**, a WebUI page where you configure the datapoint elements
worth watching, and a Python manager tells you two things about them — the
stretches of signal that resemble nothing else (**anomalies**), and the shapes
that keep coming back (**recurrences**). First over the archived history, then
continuously on live values.

This article is the field report.

## Why Python in WinCC OA matters

Not because Python is fashionable — because of what sits on PyPI. Our anomaly
detection is built on the **matrix profile** (STOMP/mSTAMP), an algorithm family
from time-series research that would be a serious undertaking in CTRL. In
Python it is NumPy arrays and FFTs; the optional acceleration is a
`pip install stumpy` away, and a pretrained forecasting model
(`chronos-forecasting`) is another. The Python Manager turns that whole
ecosystem into something a WinCC OA project can *run*, supervised by PMON like
everything else.

The essentials, from the installed documentation (`api.python/docs`):

- **WinCC OA ships no Python interpreter.** The `PythonEnv` setup component
  installs the `etm.wccoa` packages and the native extension; CPython itself is
  yours to install — exactly one version is validated per OS (3.12 on Windows
  11 / Server 2022/2025, 3.11 on Debian 12, 3.13 on Debian 13).
- Registration is one console entry: manager type `python`, options
  `my_script.py -num 60`. The number is shared with **all** scripting managers
  (CTRL, Node.js, Python) — a collision means a manager that starts and dies.
- The API is synchronous and thread-safe: `dp_get`, `dp_set_wait`,
  `dp_connect`, `dp_query`, `dp_get_period_split`, alert access, even calling
  CTRL functions. Standard `logging` lands in `PVSS_II.log`.

```python
from etm.wccoa.manager import Manager

with Manager() as manager:
    value = manager.dp_get("System1:ExampleDP_Arg1.")
    manager.dp_set_wait("System1:ExampleDP_Arg1.", 42.0)
```

## The architectural decision the beta forces — and why it turned out well

Our webserver backends normally follow one pattern: a JavaScript manager hosts
an MSA vRPC service, an HTTP route bridges to it. The Python API (in this beta)
is a **scripting API — it hosts no vRPC service**. A `/api/...` route would
have nothing to call.

So the page and the manager talk through the one bus WinCC OA already gives
you: **datapoints**. One DP per configured signal, six string leaves carrying
JSON, strictly split by writer:

```
page    ──▶  name · config · command      (the request)
manager ──▶  status · result · live      (the answer, pushed by dpConnect)
```

Two rules make this robust. **No leaf is written by both sides**, so nobody can
clobber anybody. And **every request carries a `requestId`** the manager echoes
into every status and result — so the page can tell this run's answer from the
one still sitting on the leaf from the last run.

One trap worth publicising: `dp_connect(..., answer=True)` replays the current
value on subscribe. On a manager restart, that replays the *last command ever
written* — and would happily re-run it. Treat the initial answer as state to
adopt, never as an order to execute.

What we expected to be a workaround turned out to have real virtues: the
transport is authenticated, redundant, archived if you want it to be, and the
browser gets results pushed with zero polling.

## What the analytics actually do

For every window of *m* samples, the matrix profile gives the z-normalised
distance to its nearest neighbour elsewhere in the same series. One array, read
twice: a **large** value means "this shape occurs nowhere else" — an anomaly; a
**small** value means "this shape happens again" — a recurrence, with its cycle
time. Thresholding is `median + k·MAD`, robust by construction, since the
anomalies are *in* the sample being summarised.

Three interchangeable engines: plain **NumPy** (built in, ~3 s for 20 000
points), **STUMPY** when installed, **Chronos** (forecasting: flags what was
not *predictable* rather than what never recurred). A missing engine never
fails a run — the manager falls back to NumPy and tells the page why.

The part we find genuinely exciting is **multivariate**: several elements can
form ONE joint analysis (mSTAMP). That detects the anomaly *no single signal
shows* — the correlation break. Power collapses mid-ramp while the temperature
keeps climbing on schedule: each curve alone is a plausible furnace, together
they are impossible. Each joint anomaly reports every signal's share, so the
operator knows which one to go look at.

After each historical run, the manager keeps the analysed series as a
reference and scores every incoming value against it — same metric, same
threshold. The line you learned offline *is* the alarm line online.

## A demo you can verify, not just believe

The package includes a second Python manager, `furnace_sim_manager.py`. On
start it creates a `SigSim_Furnace` datapoint, assigns archiving to the first
active NGA group, **backfills six hours of history** through
`dp_set_timed_wait`, then drives the three elements live — a batch furnace on a
10-minute cycle with two anomaly kinds injected on a **published schedule**
(written to a datapoint, as JSON): an overheat any single-signal analysis must
find, and a correlation break **only the joint analysis can find**.

That schedule is the point. The test suite generates the same furnace, runs
the same pipeline, and asserts both injections are found jointly — and that
the correlation break does *not* appear on the temperature alone. The demo's
claim is a tested property, not a hope. And everything below the `Manager` API
is plain NumPy, so 30+ tests run on a workstation with **no WinCC OA at all**,
against a fake manager that records datapoint writes.

## Beta field notes

- **Pin your interpreter.** WinCC OA searches `<project>/bin/` before `PATH`.
  On a machine with several Pythons, put the released version (or a link) in
  `<project>/bin/` — our workstation resolved `python` to 3.13 while the
  validated Windows version is 3.12.
- **The archive is event-based.** Values land when they change. Any algorithm
  that counts in samples must resample onto a uniform grid first, or a
  64-sample window covers four seconds here and four hours there.
- **`dp_connect` carries no source timestamp.** Subscribe `:_online.._stime`
  alongside the value when the instant matters.
- **Do the work off the callback thread.** Callbacks run on a pool; parse and
  enqueue there, compute in your own worker. We also serialise analyses on
  purpose — a SCADA server's cores belong to the plant.
- **Backfilling history works beautifully**: `dp_set_timed_wait` with past
  source times flows through the Event manager and lands in NGA under the
  instant it describes.
- **A restarted manager keeps its old code** — same rule as every manager.
  Redeploy means restart, and PMON's log (`PVSS_II.log`, then
  `python<num>.log`) is where a silent death explains itself.

## What we'd love to see next

Wishes from the trenches, offered constructively: MSA vRPC bindings so a
Python manager can serve HTTP bridges like its Node.js siblings; the source
time delivered in `dp_connect` callbacks; and of course the beta label falling
away.

But the takeaway stands: **the Python Manager beta is already solid enough to
carry a production-shaped feature** — provisioning datapoints, configuring
archiving, backfilling history, subscribing, and running real numerical
workloads under PMON supervision.

*A video walkthrough of the demo — "Signal Analytics — Anomaly Detection with
the WinCC OA Python Manager" — is coming; the furnace does the talking.*

---

*Built and tested on WinCC OA 3.21 (Python API 3.21.5), CPython 3.12, NumPy 2.4.
Detection: STOMP/mSTAMP (Zhu et al. 2016; Yeh et al. 2017), optional STUMPY and
Chronos engines.*
