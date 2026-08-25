# wui-signal-analytics — business & architecture notes

WinCC OA WebUI page module, **Tier 3** (frontend + a **Python** manager, no HTTP
route). Route `/signal-analytics`, component `wui-signal-analytics`.

## Domain / purpose

Two questions about one signal, and they are the same computation read twice:

- **"Has this ever looked like this before?"** — no, and it is an **anomaly**.
- **"Does this keep happening?"** — yes, and it is a **recurrence**.

Both are useful, and they are useful *together*: an operator's first reaction to
an anomaly is "compared to what?", and the recurrence list is the answer, which
is why the page puts them side by side rather than on two tabs.

Neither is an alarm. WinCC OA's alarm system answers "is this value out of
range?", which this page deliberately does not touch. A pump whose vibration
signature changes shape while staying inside every limit is exactly what this
finds and what alarming cannot.

## The bridge: why datapoints and not HTTP

The WinCC OA Python API (3.21) is a **scripting** API. It reads, writes,
subscribes and queries — and it publishes **no MSA vRPC service**. Every other
backend here (`processMonitor`, `dplAscii`, `rtspProxy`, `s7Browse`…) is a
JavaScript manager hosting a vRPC service that a webserver route calls over HTTP.
That pattern simply has no Python counterpart, so an `/api/signal-analytics`
route would have nothing to call.

The datapoint system is already a message bus with authentication, redundancy and
a push transport to the browser. So: **one datapoint per configured signal**, type
`SignalAnalysis`, six String leaves carrying JSON:

| Leaf | Written by | Content |
| --- | --- | --- |
| `name` | page | display label |
| `config` | page | what to analyse and how |
| `command` | page | `{requestId, action}` — "analyse now" |
| `status` | manager | state, progress, engine, fallback reason, runtime |
| `result` | manager | anomalies, recurrences, score band, threshold |
| `live` | manager | rolling real-time score and excursions |

Two invariants make it safe:

- **No leaf is written by both sides.** A slow write can never race an answer.
- **Every request carries a `requestId`** the manager echoes into every status
  and result, so the page can tell this run's answers from the ones still sitting
  on the leaves from the previous run.

### The replay trap

`dp_connect(..., answer=True)` delivers the *current* value immediately. A
manager restart therefore replays whatever command was last written — and would
re-run every past analysis on startup. `service.py` adopts the first `is_answer`
callback as state instead of acting on it, and drops any command whose
`requestId` it has already seen.

### The samples are not exchanged

The obvious design ships the analysed series back with the findings. It is wrong
here: 20 000 points is ~400 kB of JSON through a String DPE, on every run, for
data the browser can read from the archive in one call. So the manager sends
**findings only**, with absolute timestamps, and the page reads the same period
with `dpGetPeriod`. The two line up by construction.

The one exception is the **score band** — the profile curve under the chart —
which only the manager can compute. It is downsampled to at most 1200 points
before being sent, bucketed by **maximum** rather than mean: the curve exists to
show where the signal stops resembling itself, and averaging is exactly what
would flatten those peaks away.

## How the detection works

### The matrix profile

For each subsequence of length *m*, the z-normalised Euclidean distance to its
nearest neighbour elsewhere in the same series. One array, two readings:

- a **large** value — this shape occurs nowhere else → a *discord*, an anomaly;
- a **small** value — it occurs again → a *motif*, a recurrence.

`matrix_profile.py` implements **STOMP** (Zhu et al., 2016): the first distance
profile from an FFT sliding dot product, each later row an O(l) update of the
previous, and — because the distance matrix is symmetric — one pass over the rows
fills the whole profile. O(n²) time, O(n) memory. 20 000 points takes ~2.7 s on
this workstation.

Three details that are not obvious and are all load-bearing:

- **Distances come from the Pearson correlation**, not from the definition. That
  identity is what makes the O(1)-per-cell update possible at all.
- **Flat subsequences are a special case.** σ = 0 divides by zero, and every real
  process signal idles. Two flat stretches are declared identical, a flat one
  against a varying one maximally different. Without it the profile fills with
  NaN on the first quiet night.
- **Cumulative sums are taken on the centred series.** A cumsum over values
  sharing a large offset (an absolute pressure, a counter) loses precision in
  exactly the digits the variance is made of.

### Thresholds: median + k·MAD, never mean + k·σ

The anomalies are *in* the sample being summarised, and they are precisely the
values that would drag a mean-based threshold up above themselves. The MAD is
rescaled by 1.4826 so the sensitivity reads as "sigmas" the way an operator
expects.

### Exclusion zones — three of them, deliberately different

| Where | Width | Why |
| --- | --- | --- |
| Building the profile | `m/4` | The standard: a neighbour this close is the same shape shifted, not a second one. |
| Picking discords | `2m` | Every subsequence that merely *touches* an anomaly scores high, so one event is detected by a band of them. Two windows apart is where two detections can no longer be the same underlying event. Without this, "the top 5 anomalies" returns five views of one excursion — which is exactly what the first version did. |
| Picking motif members and successive motifs | `m` | Two occurrences that overlap are one occurrence counted twice; a second motif made of the first one's members shifted by a few samples is the same finding reported again. |

### The recurrence gate

A motif whose own best match sits as far away as an *anomaly* is not a
recurrence. `find_motifs` stops at the anomaly threshold, so the list ends when
the findings stop meaning anything rather than when the count runs out. On a
purely periodic test signal this is the difference between one motif with 37
occurrences (right) and three phase-shifted copies of it (wrong).

### Resampling — the correctness point that is easy to miss

A window counts in **samples** and silently assumes they are evenly spaced. A
WinCC OA archive is **event-based**: values land on change, on smoothing, in
bursts after a connection returns. Fed raw, a 64-sample window covers four
seconds in one place and four hours in another, and every reported cycle time is
meaningless.

So `analysis.py` interpolates onto a uniform grid and reports the resulting step
back to the page — which is what lets the dialog show a window as a duration.

It also **never upsamples**, and requires at least `4 × window` *raw* archived
values. Three archived values resampled to two hundred grid points are a straight
line with an impressive-looking analysis on top.

### The curve keeps growing

The archived curve is read once, for the analysed period. Everything the process
does afterwards arrives on a `dpConnect` subscription on the selected signal's
element (`data/live-signal.ts`) and is appended past the end of that curve —
otherwise the newest samples only appear on a page reload, which is absurd on a
page whose other half is a live watch.

Four details decide whether that is correct rather than merely animated:

- **Source time, not arrival time.** A `dpConnect` emission carries
  `{ dp, value }` and no timestamp, so `:_online.._stime` is subscribed
  alongside the value, so each point sits where the process put it. Arrival time is the fallback for an
  element whose source time is unreadable.
- **The tail is thrown away whenever the archive is re-read.** The two sources
  overlap by construction — the subscription starts before the read returns, and
  the archive keeps receiving the same values — so a new analysis resets it and
  the chart appends only samples strictly newer than the last archived one.
- **A marker line shows where the analysis stopped.** Without it the tail reads
  as part of the analysed period, and its lack of findings as "nothing wrong
  here" rather than "not examined yet".
- **The chart merges instead of replacing on a live tick.** `setOption(…, true)`
  resets the operator's zoom; at one tick a second that makes the chart unusable.
  Replacement is kept for changes of *structure* (another signal, another
  analysis, another highlighted finding) — where it is equally necessary, since
  echarts merges arrays element-wise and would otherwise leave the previous run's
  bands behind.

Notifications are throttled to one per second: a signal changing at 10 Hz would
otherwise mean ten echarts renders a second for points a pixel apart.

### Joint (multivariate) analysis — mSTAMP

A signal may name **several elements**; they are then ONE analysis, not N. The
engine runs **mSTAMP** (Yeh et al., 2017) with k = d: the z-normalised distance
profile is computed per dimension and **averaged** before each subsequence takes
its nearest neighbour. STUMPY's `mstump` computes the same aggregation (its last
profile row); the built-in `mstomp` in `matrix_profile.py` reduces exactly to
`stomp` at d = 1 (tested).

What the choice of *mean* aggregation means, stated plainly:

- an anomaly living only in the **relation** between signals — the correlation
  breaks while each signal stays individually plausible — is what the mean can
  see and per-dimension profiles cannot. This is the case the feature exists
  for, and the test suite constructs it explicitly (a phase-inverted cycle:
  invisible on `a` alone, top joint discord);
- an anomaly confined to **one** of d signals is diluted by the mean. The
  averaging also shrinks the profile's noise, so a clear event still stands out
  — but a marginal one is easier to catch by configuring that signal alone.

Each joint anomaly reports **contributions** — per element, its own univariate
nearest-neighbour distance over the anomalous window, normalised to shares.
Computed post-hoc by MASS so it works identically for `numpy` and `stumpy`.
Chronos stays univariate (the model is): per-dimension residuals aggregated by
**max**, contributions from the per-dimension peaks, and its notes say that a
relation-only anomaly is out of its reach.

Reading history for a joint signal resamples every element onto **one common
grid** spanning the intersection of their archived periods — outside it at
least one dimension would be extrapolation, and an anomaly found in
extrapolated data is an artefact. The live watch buffers per element and only
scores a window every dimension covers: a quiet source *holds* the joint score
rather than letting the others vote without it.

### The live watch

After an analysis the manager keeps the analysed series and the threshold. Every
incoming value joins a rolling buffer; on the configured throttle the newest
window is resampled to the reference's step and scored by **MASS** — the distance
to its nearest neighbour anywhere in the reference. That is the *same quantity*
the historical profile holds, so the offline threshold is directly the online
alarm line. No second model, no separate tuning.

Excursions get hysteresis on the way out (release at 0.9 × threshold), otherwise
a score hovering at the line produces a new event on every evaluation and the
page shows twenty identical rows for one physical excursion.

Live scoring stays on the matrix profile **even when the historical analysis ran
on Chronos** — a transformer forecast per incoming value would cost seconds and
buy nothing, since the reference series is exactly what "normal" means.

Live values are timestamped on **arrival**: `dp_connect` delivers a value without
its `_stime`, and one extra read per value is not worth the transport latency it
would correct.

## The engines

`numpy` and `stumpy` compute the same quantity — choosing STUMPY changes the
arithmetic's *speed*, not its meaning, and findings stay comparable. Having a
second implementation also makes the STUMPY path **verifiable**: the test suite
asserts the NumPy profile matches a brute-force one computed from the definition.

**Chronos is a different question.** It is a pretrained forecasting model: the
score is the residual in units of the model's own predictive spread,
`|actual − median| / half-interquantile-range`. Dividing by the spread is what
lets one threshold work across a plant — a noisy signal earns a wide interval and
must deviate further to count. Its advantage is that it can call a shape
anomalous the *first* time it matters, without waiting for a second occurrence to
compare against.

Its recurrences still come from the matrix profile, and the page says so.
Chronos forecasts; asking it for motifs would mean inventing a meaning it does
not have.

### Degrade, never fail

A requested engine that will not import does not fail the run: the registry falls
back to NumPy and reports *what* was asked for, *what* ran and *why*. The failure
modes are real — `stumpy` needs Numba, whose supported NumPy range trails the
current release, and `chronos-forecasting` needs torch. The `available()` checks
therefore catch more than `ImportError`.

## Display: readability of the findings

- Anomaly bands carry their **rank number**; the list rows lead with the same
  number in a badge — band ↔ row matching is a glance.
- **Recurrence bands are much fainter than anomaly bands** (0.06 vs 0.16): a
  healthy cyclic signal has an occurrence band on every cycle, and at equal
  opacity three dozen of them tint the whole chart. The exceptional must
  out-ink the routine.
- A **display filter** (chips on the chart panel) toggles anomalies /
  recurrences / score band and floors anomalies by severity. One object drives
  the chart AND the lists, so the two views can never disagree about what is
  visible; the lists say how many rows the floor hid rather than letting them
  vanish silently. Transient by design — it filters what is looked at, never
  what was found.
- The **analysis card** (`sa-summary`) prints the analysed period in full (both
  ends, dated, plus length), engine, window as a duration, points, threshold —
  and flashes when a new result lands, because clicking "Analyse" twice
  produces two different periods and the second result must read as a
  different question, not a contradiction. It also warns when the
  configuration changed after the run (window/engine/elements only — cosmetic
  edits must not cry wolf).

## Known limitations

- **O(n²).** `maxPoints` is the real control; the default 20 000 is a few
  seconds, and the form says the cost grows with the square.
- **The window is chosen by a human.** Nothing here estimates a good one.
- **The Chronos code path has not been executed.** Neither
  `chronos-forecasting` nor `torch` is installed on this workstation, so the two
  call shapes in `engines/chronos.py` come from the package's published API and
  are **unverified**. Both are attempted in turn and any failure is reported to
  the page rather than raised — but verify against the version you install before
  relying on it. The module is marked with that warning at the top.
- **Analyses are serialised.** One worker thread, on purpose: these are
  array-wide CPU loops, and four at once on a SCADA server takes cores from the
  processes running the plant.

## What is not enforced server-side

`canWrite` gates the button, and the Event manager gates the write itself: a user
without it cannot put anything on a `command` leaf, UI or no UI. What the manager
does not do is ask *who* wrote a leaf it reads — it acts on any `command` that
changes, whoever wrote it, because it has no notion of a WebUI session.

Two consequences worth stating plainly:

- a CTRL script or a PARA edit can trigger an analysis, and the manager will run
  it — the `command` leaf carries a `user` field precisely so that a deployment
  needing an authorisation check has somewhere to put it;
- the same holds for the hub: any writer with `canWrite` on
  `SignalAnalyticsHub.request` can have a `SigAnalysis_*` datapoint created or
  deleted. The fence is the prefix, not the identity of the requester — the
  manager will not touch a datapoint outside its own namespace, but it does not
  ask who asked.

## Testing

`backend/python/tests/test_signal_analytics.py` — 31 tests, no WinCC OA required:

- the NumPy profile against a **brute-force implementation from the definition**;
- a synthetic signal whose answer is known by construction (40 identical cycles,
  one replaced) — the injected shape must be the top discord, and the repeated
  cycle must be **one** motif with most of its occurrences;
- flat-signal, junk-JSON and too-short-period paths;
- the live watch: quiet under the threshold on a familiar shape, above it on an
  unfamiliar one;
- the whole service end to end against a `FakeManager` that records DP writes.

The provisioning has its own tests in the same file, against a fake engineering
manager: the name reduction (what WinCC OA would refuse never reaches
`dp_create`), the prefix fence on `delete`, create-of-an-existing as a success,
and an engineering failure surfacing as a readable `error` on `response` instead
of an exception nobody sees.

The page side has its own suite —
`libs/default-components/src/lib/standalone-pages/signal-analytics/data/live-signal.spec.ts`,
14 tests over the live tail: source-time plotting, the duplicated `answer`
emission, the non-numeric value, throttling without loss, switching element, and
the failing subscription that must cost the tail and nothing else.

```bash
npx nx test default-components
```

```bash
cd backend/python
"C:/Python/Python312/python.exe" tests/test_signal_analytics.py   # or: python -m pytest tests -q
```
