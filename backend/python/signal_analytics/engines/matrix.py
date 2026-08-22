# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""The two matrix-profile engines: built-in NumPy, and STUMPY when installed.

They differ in exactly one step — who computes the profile — so everything after
it (threshold, discords, motifs, records) is shared. That is the point of the
split: choosing ``stumpy`` on the page changes the arithmetic's *speed*, not its
meaning, and the findings stay comparable across the two.

STUMPY is the reference implementation of this family (Law, 2019) and is worth
having: it JIT-compiles through Numba and parallelises across cores, so it wins
by a wide margin from a few tens of thousands of points on. It is optional
because it cannot be assumed present — ``pip install stumpy`` on a WinCC OA
server is a deliberate act, and Numba's supported NumPy range trails the current
release often enough that the import genuinely can fail on an up-to-date box.
When it does, the page says so and the built-in engine answers instead.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..matrix_profile import (
    dimension_contributions,
    find_discords,
    find_motifs,
    mstomp,
    robust_threshold,
    stomp,
)
from .base import (
    Engine,
    EngineResult,
    ProgressFn,
    Samples,
    anomaly_records,
    profile_payload,
    recurrence_records,
)


def _findings(
    samples: Samples,
    profile: np.ndarray,
    index: np.ndarray,
    config: Any,
    engine_id: str,
    notes: list[str],
    progress: ProgressFn,
) -> EngineResult:
    """Turn a matrix profile into the page's anomalies and recurrences."""
    window = int(config.window)

    progress(70, "threshold")
    threshold = robust_threshold(profile, float(config.sensitivity))

    progress(78, "anomalies")
    discords = find_discords(profile, window, int(config.max_anomalies), threshold)
    # Post-hoc and engine-agnostic: works identically whether the joint profile
    # came from our mstomp or from stumpy.mstump.
    contributions = lambda start: dimension_contributions(samples.values, start, window)  # noqa: E731

    progress(88, "recurrences")
    # find_motifs takes the (dims, n) matrix as-is: its one contact with the
    # values goes through neighbour_distances, which dispatches on ndim.
    series = samples.values if samples.joint else samples.values[0]
    motifs = find_motifs(
        series,
        profile,
        index,
        window,
        int(config.max_recurrences),
        float(config.recurrence_radius),
        max_distance=threshold,
    )

    if not discords:
        notes.append("no-anomaly-above-threshold")
    if not motifs:
        notes.append("no-recurring-shape")

    return EngineResult(
        engine=engine_id,
        anomalies=anomaly_records(samples, discords, window, threshold, contributions),
        recurrences=recurrence_records(samples, motifs, window),
        profile=profile_payload(samples, profile, window),
        threshold=round(float(threshold), 4),
        notes=notes,
        reference=samples.values,
    )


class NumpyEngine(Engine):
    """STOMP in plain NumPy — always available, no third-party dependency."""

    id = "numpy"

    def available(self) -> tuple[bool, str]:
        return True, ""

    def analyse(self, samples: Samples, config: Any, progress: ProgressFn) -> EngineResult:
        progress(25, "matrix profile" + (" (joint)" if samples.joint else ""))
        if samples.joint:
            profile, index = mstomp(samples.values, int(config.window))
            notes = [f"joint analysis over {samples.dim_count} signals (mSTAMP, k = d)"]
        else:
            profile, index = stomp(samples.values[0], int(config.window))
            notes = []
        return _findings(samples, profile, index, config, self.id, notes, progress)


class StumpyEngine(Engine):
    """The same profile computed by STUMPY (Numba-compiled, multi-core)."""

    id = "stumpy"

    def available(self) -> tuple[bool, str]:
        try:
            import stumpy  # noqa: F401
        except ImportError as error:
            return False, f"stumpy is not installed ({error})"
        except Exception as error:  # numba/NumPy ABI mismatches surface here
            return False, f"stumpy failed to load ({error})"
        return True, ""

    def analyse(self, samples: Samples, config: Any, progress: ProgressFn) -> EngineResult:
        import stumpy

        notes = [f"stumpy {getattr(stumpy, '__version__', 'unknown')}"]
        if samples.joint:
            progress(25, "matrix profile (stumpy.mstump)")
            # mstump returns the k-dimensional profiles as rows P[k-1]; the last
            # row is k = d — every dimension counted, the same aggregation as our
            # own mstomp, so the two engines' thresholds mean the same thing.
            profiles, indices = stumpy.mstump(samples.values, m=int(config.window))
            profile = np.asarray(profiles[-1], dtype=np.float64)
            index = np.asarray(indices[-1], dtype=np.int64)
            notes.append(f"joint analysis over {samples.dim_count} signals (mstump, k = d)")
        else:
            progress(25, "matrix profile (stumpy)")
            # stump() returns one row per subsequence: [profile, index, left,
            # right], in an object array — hence the explicit casts.
            computed = stumpy.stump(samples.values[0], m=int(config.window))
            profile = np.asarray(computed[:, 0], dtype=np.float64)
            index = np.asarray(computed[:, 1], dtype=np.int64)
        return _findings(samples, profile, index, config, self.id, notes, progress)
