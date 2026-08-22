# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""From WinCC OA archives to the matrix an engine can work on.

Two steps, and the second one is the one that matters.

**Reading.** ``dp_get_period_split`` rather than ``dp_get_period``: a month of a
one-second signal is millions of values, and the split form is the API's answer
to a result that does not fit one reply. Small periods take the same path and
finish on the first chunk. Each configured element is read separately — their
archives are independent and one element's smoothing settings say nothing about
another's.

**Resampling onto ONE uniform grid.** A matrix profile — and a forecast horizon —
count in *samples*, and both silently assume those samples are evenly spaced. A
WinCC OA archive is event-based: values land when they change, on smoothing, in
bursts after a connection returns. Fed raw, a 64-sample window would cover four
seconds in one place and four hours in another, and every motif period would be
meaningless.

For a **joint** analysis the grid must additionally be *common*: mSTAMP compares
the signals sample-by-sample, so "the same instant" has to mean the same index in
every dimension. The grid therefore spans the intersection of the periods the
elements actually cover, and every dimension is interpolated onto exactly it. The
resulting step is reported back to the page, which is what lets it show a window
as a duration ("64 samples = 3 min 12 s") instead of a bare count.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np

from .engines import Samples
from .protocol import SignalConfig, to_epoch_ms

logger = logging.getLogger(__name__)

#: Archived values live under the original config; the same attribute the WebUI
#: pages read with ``dpGetPeriod`` (see ``libs/wui-*/src/**/engine.ts``).
VALUE_ATTRIBUTE = ":_original.._value"

#: Hard stop on the split-request loop, so a driver that never reports 100 %
#: cannot spin this thread forever.
MAX_CHUNKS = 200

#: A window needs at least this many of them to be worth a profile at all.
MIN_WINDOWS = 4


class HistoryError(RuntimeError):
    """The period could not be read, or held too little to analyse."""


@dataclass(frozen=True)
class Prepared:
    """The analysable series plus what had to be done to obtain them."""

    samples: Samples
    raw_count: int
    step_ms: int
    notes: list[str]


def _period_dpe(dpe: str) -> str:
    """The DPE name to read history from (already-explicit names pass through)."""
    return dpe if ":" in dpe.split(".", 1)[-1] else dpe + VALUE_ATTRIBUTE


def _numeric(value: Any) -> float | None:
    """An ``OaVariant`` (or a plain value) as a float, or ``None`` if it is not one."""
    unwrapped = getattr(value, "value", value)
    if isinstance(unwrapped, bool):
        return 1.0 if unwrapped else 0.0
    try:
        number = float(unwrapped)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def read_history(manager: Any, config: SignalConfig, dpe: str) -> tuple[np.ndarray, np.ndarray]:
    """Read the configured period of ONE element as ``(times_ms, values)``, ascending.

    Non-numeric and non-finite values are dropped rather than coerced: a signal
    that archives a status string alongside its measurement should analyse the
    measurement, not a series of zeros where the strings were.
    """
    start, end = config.period()
    target = _period_dpe(dpe)

    times: list[int] = []
    values: list[float] = []
    chunk = manager.dp_get_period_split(start, end, [target])
    for _ in range(MAX_CHUNKS):
        for item in chunk.data:
            number = _numeric(item.dp_value)
            if number is None:
                continue
            times.append(to_epoch_ms(item.source_time))
            values.append(number)
        if getattr(chunk, "progress", 100) >= 100:
            break
        chunk = manager.dp_get_period_split(chunk.request_id)
    else:
        logger.warning("%s: history read stopped after %d chunks", dpe, MAX_CHUNKS)

    if not times:
        raise HistoryError(f"no archived numeric value for {dpe} in the requested period")

    order = np.argsort(np.asarray(times, dtype=np.int64), kind="stable")
    ordered_times = np.asarray(times, dtype=np.int64)[order]
    ordered_values = np.asarray(values, dtype=np.float64)[order]
    # Several values on the same millisecond would give the grid a zero-length
    # step; the last one written wins, as it does in the process image.
    unique = np.concatenate([np.diff(ordered_times) > 0, [True]])
    return ordered_times[unique], ordered_values[unique]


def prepare(
    series: list[tuple[np.ndarray, np.ndarray]],
    config: SignalConfig,
) -> Prepared:
    """Resample every element onto one uniform grid sized for the window.

    *series* is one ``(times, values)`` pair per configured element, in
    ``config.dpes`` order. The grid spans the **intersection** of their covered
    periods: outside it at least one dimension would be pure extrapolation, and
    an anomaly found in extrapolated data is an artefact, not a finding.
    """
    if len(series) == 0:
        raise HistoryError("no series to analyse")
    notes: list[str] = []

    # A shape of *window* samples cannot be looked for in a period that holds
    # barely more than one of them, and interpolation does not create the data
    # that is missing: three archived values resampled to two hundred grid points
    # are a straight line with an impressive-looking analysis on top. So the
    # requirement is on the RAW count of every element, and the grid never
    # upsamples beyond the sparsest one.
    minimum = config.window * MIN_WINDOWS
    for (times, values), dpe in zip(series, config.dpes):
        if int(values.size) < minimum:
            raise HistoryError(
                f"{dpe}: a window of {config.window} samples needs at least "
                f"{minimum} archived values, the period holds {int(values.size)}"
            )

    start = max(float(times[0]) for times, _values in series)
    end = min(float(times[-1]) for times, _values in series)
    if end <= start:
        raise HistoryError("the configured elements share no overlapping archived period")
    if len(series) > 1:
        notes.append("grid spans the overlap of all elements' archived periods")

    raw_count = min(int(values.size) for _times, values in series)
    target = int(min(max(config.max_points, minimum), raw_count))
    if target < raw_count:
        notes.append(f"downsampled from {raw_count} to {target} points")

    grid = np.linspace(start, end, target)
    matrix = np.empty((len(series), target))
    for dim, (times, values) in enumerate(series):
        matrix[dim] = np.interp(grid, times.astype(np.float64), values)
    step = int(round((end - start) / max(1, target - 1)))

    return Prepared(
        samples=Samples(times=grid.astype(np.int64), values=matrix, dpes=tuple(config.dpes)),
        raw_count=raw_count,
        step_ms=max(step, 1),
        notes=notes,
    )
