# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""The simulator's guarantees — and the loop back to the detector.

The simulator exists to make the detection *verifiable*, so its tests close the
loop: generate the furnace exactly as the manager would write it, run the same
analysis pipeline the Signal Analytics manager runs, and check the findings
against the published injection schedule. If these pass, the demo's claim — "the
page finds the injected anomalies, and the correlation break only jointly" — is
a tested property, not a hope.

Run from ``backend/python``::

    python -m pytest tests -q
    python tests/test_furnace_sim.py
"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from furnace_sim.process import (  # noqa: E402
    ANOMALY_EVERY_CYCLES,
    CYCLE_S,
    ELEMENTS,
    sample_at,
    scheduled_anomalies,
)
from signal_analytics.matrix_profile import (  # noqa: E402
    find_discords,
    mstomp,
    robust_threshold,
    stomp,
)

#: One sample every 5 s, matching the manager's beat.
STEP_S = 5

#: Analysis window ≈ one batch cycle (600 s / 5 s).
WINDOW = CYCLE_S // STEP_S


def generate(hours: float, start_s: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """The furnace as the manager would write it: (times_ms, values (3, n))."""
    count = int(hours * 3600 // STEP_S)
    times_s = np.arange(start_s, start_s + count * STEP_S, STEP_S)
    matrix = np.empty((len(ELEMENTS), times_s.size))
    for at, timestamp in enumerate(times_s):
        matrix[:, at] = sample_at(float(timestamp)).as_tuple()
    return times_s * 1000, matrix


def test_the_process_is_a_pure_function_of_time() -> None:
    """Backfill and live loop must agree sample by sample — same clock, same value."""
    assert sample_at(123_456.0) == sample_at(123_456.0)
    a = sample_at(987_650.0)
    b = sample_at(987_655.0)
    assert (a.temperature, a.power) != (b.temperature, b.power) or a != b


def test_the_schedule_names_both_anomaly_kinds() -> None:
    span_ms = ANOMALY_EVERY_CYCLES * CYCLE_S * 1000
    injected = scheduled_anomalies(0, span_ms)
    kinds = {item.kind for item in injected}
    assert kinds == {"overheat", "correlation-break"}
    for item in injected:
        assert item.end_ms > item.start_ms


def test_healthy_cycles_are_actually_recurrent() -> None:
    """Away from the injections, consecutive cycles must be near-identical shapes."""
    times_ms, matrix = generate(hours=2.0)
    temperature = matrix[0]
    # Two healthy cycles (offsets 0 and 1 of the anomaly block).
    one = temperature[0 : WINDOW]
    two = temperature[WINDOW : 2 * WINDOW]
    correlation = np.corrcoef(one, two)[0, 1]
    assert correlation > 0.99, correlation


def _detect(matrix: np.ndarray, joint: bool) -> list[tuple[int, float]]:
    series = matrix if joint else matrix[0]
    profile, _index = mstomp(series, WINDOW) if joint else stomp(series, WINDOW)
    threshold = robust_threshold(profile, 3.0)
    return find_discords(profile, WINDOW, 6, threshold)


def _covers(discords: list[tuple[int, float]], times_ms: np.ndarray, start_ms: int, end_ms: int) -> bool:
    """Does any discord window overlap the injected span?"""
    for index, _score in discords:
        begin = int(times_ms[index])
        finish = int(times_ms[min(index + WINDOW - 1, times_ms.size - 1)])
        if finish >= start_ms and begin <= end_ms:
            return True
    return False


def test_the_analysis_finds_what_the_simulator_injected() -> None:
    """The full loop: 12 cycles of furnace, both injected anomalies found jointly."""
    hours = ANOMALY_EVERY_CYCLES * CYCLE_S / 3600.0
    times_ms, matrix = generate(hours=hours)
    injected = scheduled_anomalies(int(times_ms[0]), int(times_ms[-1]))
    assert len(injected) == 2, injected

    discords = _detect(matrix, joint=True)
    for item in injected:
        assert _covers(discords, times_ms, item.start_ms, item.end_ms), (
            f"joint analysis missed the injected {item.kind}"
        )


def test_the_correlation_break_needs_the_joint_analysis() -> None:
    """The break must be found jointly — and NOT on the temperature alone.

    This is the property the whole multivariate feature was built for, proven on
    the very data the simulator writes into the project.
    """
    hours = ANOMALY_EVERY_CYCLES * CYCLE_S / 3600.0
    times_ms, matrix = generate(hours=hours)
    injected = {item.kind: item for item in scheduled_anomalies(int(times_ms[0]), int(times_ms[-1]))}
    break_item = injected["correlation-break"]

    jointly = _detect(matrix, joint=True)
    assert _covers(jointly, times_ms, break_item.start_ms, break_item.end_ms)

    # The temperature is deliberately untouched by the break: alone it must
    # stay quiet there (the overheat, which IS on the temperature, may show).
    temperature_only = _detect(matrix, joint=False)
    assert not _covers(temperature_only, times_ms, break_item.start_ms, break_item.end_ms), (
        "the break leaked into the temperature-only analysis — the simulator no "
        "longer demonstrates the joint case"
    )


def main() -> int:
    failures = 0
    for name, test in sorted(globals().items()):
        if not name.startswith("test_") or not callable(test):
            continue
        try:
            test()
            print(f"  ok   {name}")
        except Exception as error:  # noqa: BLE001 - a test runner reports, it does not raise
            failures += 1
            print(f"  FAIL {name}: {error}")
    print(f"\n{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
