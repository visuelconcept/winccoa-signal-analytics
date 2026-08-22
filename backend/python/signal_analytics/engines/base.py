# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""What an analysis engine receives, what it returns, and the shared conversion.

An engine's whole job is to turn a sampled signal into two lists — anomalies and
recurrences — expressed in wall-clock time. Everything downstream (the JSON on
the ``result`` leaf, the markers on the page's chart) works from those lists and
never sees the arrays behind them.

The index → timestamp conversion lives here rather than in each engine because
getting it wrong is silent: a subsequence starting at index *i* spans
``t[i] … t[i + m - 1]``, and using ``t[i]`` alone would draw every anomaly as a
zero-width tick at the *start* of a shape whose whole point is its duration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

import numpy as np

#: The profile is a decoration under the chart, not data — a few hundred points
#: are plenty, and a String DPE is not the place for tens of thousands of floats.
PROFILE_MAX_POINTS = 1200

#: Reports progress (0–100) with a short message while an analysis runs.
ProgressFn = Callable[[int, str], None]


@dataclass(frozen=True)
class Samples:
    """The signal(s) as analysed: one shared time grid, one row per element.

    ``values`` is ALWAYS a ``(dims, n)`` matrix, even univariate — one shape for
    every engine beats a scattering of ``ndim`` checks. The rows are aligned
    sample-by-sample on :attr:`times`, which is what a joint analysis means.
    """

    times: np.ndarray
    """Epoch milliseconds, ``int64``, length *n*."""

    values: np.ndarray
    """``float64``, shape ``(dims, n)``."""

    dpes: tuple[str, ...] = ()
    """The analysed elements, one per row of :attr:`values`."""

    def __post_init__(self) -> None:
        if self.values.ndim == 1:
            object.__setattr__(self, "values", self.values[None, :])

    @property
    def size(self) -> int:
        return int(self.values.shape[-1])

    @property
    def dim_count(self) -> int:
        return int(self.values.shape[0])

    @property
    def joint(self) -> bool:
        return self.dim_count > 1

    @property
    def span(self) -> tuple[int, int]:
        if self.size == 0:
            return 0, 0
        return int(self.times[0]), int(self.times[-1])


@dataclass
class EngineResult:
    """Everything one analysis produced."""

    engine: str
    anomalies: list[dict[str, Any]] = field(default_factory=list)
    recurrences: list[dict[str, Any]] = field(default_factory=list)
    profile: dict[str, Any] | None = None
    threshold: float = 0.0
    notes: list[str] = field(default_factory=list)

    reference: np.ndarray | None = None
    """``(dims, n)`` values kept for the real-time watch to score against."""


class Engine(Protocol):
    """An analysis back-end. Implementations live next to this file."""

    id: str

    def available(self) -> tuple[bool, str]:
        """``(usable, reason)`` — the reason is shown to the user when not usable."""

    def analyse(self, samples: Samples, config: Any, progress: ProgressFn) -> EngineResult:
        """Analyse the samples under *config*, reporting progress as it goes."""


def window_span(samples: Samples, start: int, window: int) -> tuple[int, int]:
    """Wall-clock span of the subsequence starting at index *start*."""
    last = min(start + window - 1, samples.size - 1)
    return int(samples.times[start]), int(samples.times[last])


def anomaly_records(
    samples: Samples,
    discords: list[tuple[int, float]],
    window: int,
    threshold: float,
    contributions_of: Callable[[int], list[float]] | None = None,
) -> list[dict[str, Any]]:
    """Discords as page-facing anomaly records, most severe first.

    ``severity`` is the score expressed in multiples of the threshold, which is
    the number that survives a change of unit, of sensitivity or of engine — the
    raw distance does not, so the page ranks on this one.
    """
    records: list[dict[str, Any]] = []
    for rank, (start, score) in enumerate(discords, start=1):
        begin, end = window_span(samples, start, window)
        record: dict[str, Any] = {
            "rank": rank,
            "start": begin,
            "end": end,
            "index": int(start),
            "score": round(float(score), 4),
            "severity": round(float(score / threshold), 3) if threshold > 0 else None,
        }
        # Joint analyses name the share each signal had in the strangeness —
        # "which one do I go and look at" is the operator's next question.
        if contributions_of is not None and samples.joint:
            shares = contributions_of(int(start))
            record["contributions"] = {
                dpe: round(share, 3) for dpe, share in zip(samples.dpes, shares)
            }
        records.append(record)
    return records


def recurrence_records(
    samples: Samples,
    motifs: list[dict[str, Any]],
    window: int,
) -> list[dict[str, Any]]:
    """Motifs as page-facing recurrence records, tightest match first.

    ``period`` is the median gap between consecutive occurrences: for a cyclic
    process that is the cycle time, and it is the field that turns "this shape
    repeats" into something an operator can act on.
    """
    records: list[dict[str, Any]] = []
    for rank, motif in enumerate(motifs, start=1):
        members = [int(member) for member in motif["members"]]
        occurrences = [
            {"start": begin, "end": end, "index": member}
            for member, (begin, end) in ((m, window_span(samples, m, window)) for m in members)
        ]
        starts = np.array([occurrence["start"] for occurrence in occurrences], dtype=np.float64)
        period = int(np.median(np.diff(starts))) if starts.size >= 2 else None
        records.append(
            {
                "rank": rank,
                "id": f"motif-{rank}",
                "count": len(occurrences),
                "distance": round(float(motif["distance"]), 4),
                "periodMs": period,
                "occurrences": occurrences,
            }
        )
    return records


def profile_payload(samples: Samples, profile: np.ndarray, window: int) -> dict[str, Any] | None:
    """The profile downsampled for the page's score band, or ``None`` if empty.

    Buckets keep their **maximum**, not their mean: this curve exists to show
    where the signal stops resembling itself, and averaging is precisely what
    would flatten those peaks away.
    """
    finite = np.isfinite(profile)
    if profile.size == 0 or not finite.any():
        return None

    cleaned = np.where(finite, profile, 0.0)
    step = max(1, int(np.ceil(cleaned.size / PROFILE_MAX_POINTS)))
    usable = (cleaned.size // step) * step
    if usable == 0:
        return None

    buckets = cleaned[:usable].reshape(-1, step).max(axis=1)
    times = samples.times[:usable:step]
    return {
        "t": [int(value) for value in times[: buckets.size]],
        "v": [round(float(value), 4) for value in buckets],
        "window": int(window),
    }
