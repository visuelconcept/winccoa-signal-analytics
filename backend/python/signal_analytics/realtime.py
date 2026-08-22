# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""The live half: scoring what is happening now against what the history taught.

After a historical analysis the manager keeps two things — the analysed series
and the threshold derived from its profile. From then on, every value that
arrives on the signal is appended to a rolling buffer, and the newest window is
scored by the *same* quantity the historical profile holds: the z-normalised
distance to its nearest neighbour anywhere in the reference. So a live score and
a historical one are on one scale, and the threshold learnt offline is directly
the alarm line online. No second model, no separate tuning.

Two details make that honest rather than approximately true.

**The buffer is resampled to the reference's step before scoring.** Live values
arrive when the process sends them; the reference is a uniform grid. Comparing
one against the other raw would compare shapes of different durations.

**The score is a distance, so it is blind to scale and offset** — z-normalisation
is part of the metric. A shape that repeats at a higher level still reads as
familiar, which is what an operator expects, and a *level* change is caught by
the alarm system, which is where it belongs.

Several signals are scored **jointly**, the way the historical analysis scored
them: each element feeds its own buffer, the newest common window is resampled
per dimension onto the reference's step, and the score is the mean per-dimension
distance to the jointly nearest moment of the reference — ``mass_multi``, the
same aggregation ``mstomp`` used to learn the threshold. A window only counts
once EVERY dimension covers it; a signal whose source has gone quiet holds the
scoring rather than letting the others vote without it, because a joint score
computed on stale data for one dimension is exactly the false alarm this page
must not raise.

Real-time scoring stays on the matrix profile even when the historical analysis
ran on Chronos: a transformer forecast per incoming value would cost seconds and
buy nothing here — the reference series is exactly what "normal" means.

The timestamp used is arrival time. ``dp_connect`` delivers a value without its
source timestamp (see ``OaDpValueItem``), and one extra read of ``:_online.._stime``
per value is not worth it for a rolling display; the difference is the transport
latency, milliseconds on a live system.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from typing import Any

import numpy as np

from .matrix_profile import mass_multi
from .protocol import SignalConfig, now_iso

logger = logging.getLogger(__name__)

#: Scores kept for the page's live sparkline.
RECENT_SCORES = 180

#: Anomaly events kept per signal.
MAX_EVENTS = 25

#: A new event is only opened once the score has come back under the threshold —
#: this is the hysteresis on the way down, as a fraction of it.
RELEASE_RATIO = 0.9


class LiveWatch:
    """Rolling anomaly scoring for one configured signal.

    Values arrive on a subscription callback thread; the page reads the JSON
    this produces. Both sides go through :attr:`_lock`, which is held only for
    list surgery — never across the distance computation.
    """

    def __init__(self, config: SignalConfig) -> None:
        self._config = config
        self._lock = threading.Lock()
        # One buffer pair per analysed element, keyed by the configured name.
        self._times: dict[str, deque[int]] = {
            dpe: deque(maxlen=config.buffer_points) for dpe in config.dpes
        }
        self._values: dict[str, deque[float]] = {
            dpe: deque(maxlen=config.buffer_points) for dpe in config.dpes
        }
        self._recent: deque[dict[str, Any]] = deque(maxlen=RECENT_SCORES)
        self._events: deque[dict[str, Any]] = deque(maxlen=MAX_EVENTS)

        self._reference: np.ndarray | None = None
        self._threshold = float("inf")
        self._step_ms = 1000
        self._engine = ""
        self._last_evaluated = 0.0
        self._above = False

    @property
    def armed(self) -> bool:
        """True once a historical analysis has given it something to compare to."""
        return self._reference is not None

    def arm(self, reference: np.ndarray, threshold: float, step_ms: int, engine: str) -> None:
        """Adopt the reference series and threshold of a finished analysis."""
        with self._lock:
            self._reference = np.atleast_2d(np.ascontiguousarray(reference, dtype=np.float64))
            self._threshold = float(threshold)
            self._step_ms = max(1, int(step_ms))
            self._engine = engine
            self._recent.clear()
            self._above = False

    def push(self, dpe: str, value: float, timestamp_ms: int) -> None:
        with self._lock:
            times = self._times.get(dpe)
            values = self._values.get(dpe)
            if times is None or values is None:
                return
            times.append(int(timestamp_ms))
            values.append(float(value))

    def due(self) -> bool:
        """True when the throttle allows another evaluation."""
        return (time.monotonic() - self._last_evaluated) * 1000.0 >= self._config.throttle_ms

    def evaluate(self) -> str | None:
        """Score the newest window; returns the ``live`` JSON, or ``None``.

        ``None`` means "nothing new to publish" — not armed yet, or the buffer
        does not span a full window. Writing a datapoint on every incoming value
        would put more load on the event manager than the analysis itself.
        """
        self._last_evaluated = time.monotonic()

        with self._lock:
            if self._reference is None:
                return None
            if any(len(times) < 2 for times in self._times.values()):
                return None
            snapshot = {
                dpe: (
                    np.fromiter(self._times[dpe], dtype=np.int64, count=len(self._times[dpe])),
                    np.fromiter(self._values[dpe], dtype=np.float64, count=len(self._values[dpe])),
                )
                for dpe in self._config.dpes
            }
            reference = self._reference
            threshold = self._threshold
            step = self._step_ms
            engine = self._engine

        window = int(self._config.window)
        needed = window * step
        # The joint window ends at the SLOWEST element's newest value: past that
        # instant at least one dimension would be extrapolated, and a joint score
        # over extrapolated data is a false alarm waiting to be raised.
        end = min(float(times[-1]) for times, _values in snapshot.values())
        if any(end - float(times[0]) < needed for times, _values in snapshot.values()):
            return None

        grid = np.linspace(end - needed + step, end, window)
        latest = np.stack(
            [
                np.interp(grid, times.astype(np.float64), values)
                for times, values in snapshot.values()
            ]
        )

        distances = mass_multi(latest, reference, window)
        finite = distances[np.isfinite(distances)]
        if finite.size == 0:
            return None
        score = float(finite.min())

        with self._lock:
            self._recent.append({"t": int(end), "s": round(score, 4)})
            self._register(score, int(grid[0]), int(end), threshold)
            payload = {
                "updatedAt": now_iso(),
                "engine": engine,
                "armed": True,
                "score": round(score, 4),
                "threshold": round(threshold, 4),
                "severity": round(score / threshold, 3) if threshold > 0 else None,
                "anomaly": score > threshold,
                "stepMs": step,
                "window": {"start": int(grid[0]), "end": int(end)},
                "bufferPoints": min(int(values.size) for _times, values in snapshot.values()),
                "recent": list(self._recent),
                "events": list(self._events),
            }
        return json.dumps(payload, separators=(",", ":"))

    def idle_payload(self, reason: str) -> str:
        """The ``live`` JSON for a signal that is not (yet) being scored."""
        return json.dumps(
            {
                "updatedAt": now_iso(),
                "engine": self._engine,
                "armed": False,
                "reason": reason,
                "recent": [],
                "events": list(self._events),
            },
            separators=(",", ":"),
        )

    def _register(self, score: float, start: int, end: int, threshold: float) -> None:
        """Open, extend or close the current anomaly event. Caller holds the lock.

        Hysteresis on the way out: a score that hovers around the threshold would
        otherwise produce a new event on every evaluation, and the page would
        show a list of twenty identical rows for one physical excursion.
        """
        if score > threshold:
            if self._above and self._events:
                current = self._events[-1]
                current["end"] = end
                current["score"] = max(current["score"], round(score, 4))
            else:
                self._events.append(
                    {
                        "start": start,
                        "end": end,
                        "score": round(score, 4),
                        "threshold": round(threshold, 4),
                        "at": now_iso(),
                    }
                )
            self._above = True
        elif score < threshold * RELEASE_RATIO:
            self._above = False
