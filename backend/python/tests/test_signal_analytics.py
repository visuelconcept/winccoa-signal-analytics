# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for the Signal Analytics manager — no WinCC OA required.

Everything below the ``Manager`` API is ordinary NumPy, so it is tested against
synthetic signals whose answer is known by construction: a repeated cycle with
one shape replaced is a series with exactly one anomaly and exactly one motif.
The service layer is exercised against :class:`FakeManager`, which records the
datapoint writes instead of performing them.

Run from ``backend/python``::

    python -m pytest tests -q          # with pytest
    python tests/test_signal_analytics.py   # without
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from signal_analytics.analysis import HistoryError, prepare  # noqa: E402
from signal_analytics.engines import resolve_engine  # noqa: E402
from signal_analytics.engines.base import Samples  # noqa: E402
from signal_analytics.matrix_profile import (  # noqa: E402
    dimension_contributions,
    find_discords,
    find_motifs,
    mass,
    mass_multi,
    mstomp,
    robust_threshold,
    sliding_stats,
    stomp,
)
from signal_analytics.protocol import parse_command, parse_config  # noqa: E402
from signal_analytics.realtime import LiveWatch  # noqa: E402

WINDOW = 50
CYCLES = 40
ANOMALY_AT = 1000


def signal_with_one_anomaly(seed: int = 7) -> np.ndarray:
    """40 identical sine cycles, one of them replaced by a faster, larger one."""
    rng = np.random.default_rng(seed)
    cycle = np.sin(np.linspace(0, 2 * np.pi, WINDOW))
    series = np.tile(cycle, CYCLES) + rng.normal(0, 0.05, WINDOW * CYCLES)
    series[ANOMALY_AT : ANOMALY_AT + WINDOW] = 3.0 * np.sin(np.linspace(0, 6 * np.pi, WINDOW))
    return series


def brute_force_profile(series: np.ndarray, window: int) -> np.ndarray:
    """The matrix profile from its definition — the oracle for :func:`stomp`."""
    length = series.size - window + 1
    excluded = max(1, int(np.ceil(window / 4.0)))
    subsequences = np.stack([series[i : i + window] for i in range(length)])
    means = subsequences.mean(axis=1, keepdims=True)
    deviations = subsequences.std(axis=1, keepdims=True)
    normalised = (subsequences - means) / np.where(deviations == 0, 1.0, deviations)
    profile = np.empty(length)
    for i in range(length):
        distances = np.linalg.norm(normalised - normalised[i], axis=1)
        distances[max(0, i - excluded) : i + excluded + 1] = np.inf
        profile[i] = distances.min()
    return profile


# --- matrix profile -----------------------------------------------------------


def test_sliding_stats_match_numpy() -> None:
    series = signal_with_one_anomaly()[:400]
    mu, sigma = sliding_stats(series, WINDOW)
    expected_mu = np.array([series[i : i + WINDOW].mean() for i in range(mu.size)])
    expected_sigma = np.array([series[i : i + WINDOW].std() for i in range(sigma.size)])
    assert np.allclose(mu, expected_mu, atol=1e-8)
    assert np.allclose(sigma, expected_sigma, atol=1e-8)


def test_stomp_matches_the_definition() -> None:
    series = signal_with_one_anomaly()[:600]
    assert np.allclose(stomp(series, WINDOW)[0], brute_force_profile(series, WINDOW), atol=1e-6)


def test_stomp_survives_a_constant_signal() -> None:
    """A flat signal has no shape; it must not produce NaN or blow up."""
    profile, index = stomp(np.full(500, 42.0), WINDOW)
    assert np.isfinite(profile).all()
    assert np.allclose(profile, 0.0, atol=1e-6)
    assert (index >= 0).all()


def test_the_injected_anomaly_is_the_top_discord() -> None:
    series = signal_with_one_anomaly()
    profile, _ = stomp(series, WINDOW)
    threshold = robust_threshold(profile, 3.0)
    discords = find_discords(profile, WINDOW, 5, threshold)
    assert discords, "no discord above the threshold"
    top = discords[0][0]
    # The best discord must be a window that actually covers the injected shape.
    assert ANOMALY_AT - WINDOW <= top <= ANOMALY_AT + WINDOW


def test_the_repeated_cycle_is_found_once_with_all_its_occurrences() -> None:
    series = signal_with_one_anomaly()
    profile, index = stomp(series, WINDOW)
    motifs = find_motifs(
        series, profile, index, WINDOW, 3, 3.0, max_distance=robust_threshold(profile, 3.0)
    )
    assert len(motifs) == 1, "one repeated shape, so one motif — not several views of it"
    assert len(motifs[0]["members"]) > CYCLES // 2


def test_two_distinct_shapes_give_two_motifs() -> None:
    rng = np.random.default_rng(3)
    sine = np.sin(np.linspace(0, 2 * np.pi, WINDOW))
    ramp = np.linspace(-1, 1, WINDOW)
    series = np.concatenate([np.tile(sine, 10), np.tile(ramp, 10), np.tile(sine, 10), np.tile(ramp, 10)])
    series = series + rng.normal(0, 0.03, series.size)
    profile, index = stomp(series, WINDOW)
    motifs = find_motifs(
        series, profile, index, WINDOW, 4, 3.0, max_distance=robust_threshold(profile, 3.0)
    )
    assert len(motifs) >= 2


def test_mass_agrees_with_the_self_join_on_the_same_subsequence() -> None:
    series = signal_with_one_anomaly()[:800]
    profile, _ = stomp(series, WINDOW)
    start = 300
    distances = mass(series[start : start + WINDOW], series, WINDOW)
    excluded = max(1, WINDOW // 4)
    distances[max(0, start - excluded) : start + excluded + 1] = np.inf
    assert abs(float(distances.min()) - float(profile[start])) < 1e-6


# --- configuration ------------------------------------------------------------


def test_config_defaults_and_clamping() -> None:
    config = parse_config("Sig_x", json.dumps({"dpe": "System1:X.", "window": 0, "engine": "nope"}))
    assert config is not None
    assert config.window == 4, "a window of 0 must be clamped, not divide by zero"
    assert config.engine == "numpy", "an unknown engine falls back rather than failing"
    assert config.is_runnable


def test_config_rejects_junk() -> None:
    assert parse_config("Sig_x", "") is None
    assert parse_config("Sig_x", "not json") is None
    assert parse_config("Sig_x", "[1,2,3]") is None


def test_command_parsing() -> None:
    command = parse_command(json.dumps({"requestId": "r1", "action": "analyze"}))
    assert command is not None and command.is_run
    assert parse_command(json.dumps({"action": ""})) is None


def test_unavailable_engine_falls_back_with_a_reason() -> None:
    engine, reason = resolve_engine("chronos")
    if engine.id == "chronos":
        assert reason == ""
    else:
        assert engine.id == "numpy" and reason != ""


# --- resampling ---------------------------------------------------------------


def _config(**overrides: object):
    payload = {"dpe": "System1:X.", "window": WINDOW, "history": {"hours": 1, "maxPoints": 1000}}
    payload.update(overrides)
    config = parse_config("Sig_x", json.dumps(payload))
    assert config is not None
    return config


def test_prepare_puts_irregular_samples_on_a_regular_grid() -> None:
    rng = np.random.default_rng(1)
    # Deliberately bursty timestamps — what an event-based archive looks like.
    gaps = rng.integers(100, 5000, 800)
    times = np.cumsum(gaps) + 1_700_000_000_000
    values = np.sin(np.linspace(0, 20 * np.pi, times.size))
    prepared = prepare([(times.astype(np.int64), values)], _config())
    steps = np.diff(prepared.samples.times)
    assert steps.max() - steps.min() <= 1, "the grid must be uniform to the millisecond"
    assert prepared.samples.times[0] == times[0]
    assert prepared.step_ms > 0


def test_prepare_refuses_a_period_too_short_for_the_window() -> None:
    times = np.array([0, 1000, 2000], dtype=np.int64)
    try:
        prepare([(times, np.array([1.0, 2.0, 3.0]))], _config(history={"hours": 1, "maxPoints": 100}))
    except HistoryError:
        return
    raise AssertionError("a window of 50 samples cannot be analysed over 100 points")


# --- real-time ----------------------------------------------------------------


def test_live_watch_scores_a_new_anomaly_above_the_threshold() -> None:
    series = signal_with_one_anomaly()
    profile, _ = stomp(series, WINDOW)
    threshold = robust_threshold(profile, 3.0)

    watch = LiveWatch(_config(realtime={"enabled": True, "bufferPoints": 500, "throttleMs": 0}))
    watch.arm(series, threshold, step_ms=1000, engine="numpy")
    assert watch.armed

    now = int(time.time() * 1000)
    # Feed a normal cycle: familiar shape, so the score stays under the line.
    normal = np.sin(np.linspace(0, 2 * np.pi, WINDOW))
    for offset, value in enumerate(np.tile(normal, 3)):
        watch.push("System1:X.", float(value), now + offset * 1000)
    payload = json.loads(watch.evaluate() or "{}")
    assert payload["anomaly"] is False, payload

    # Then a shape the reference never contains.
    strange = 5.0 * np.sign(np.sin(np.linspace(0, 9 * np.pi, WINDOW * 2)))
    for offset, value in enumerate(strange):
        watch.push("System1:X.", float(value), now + (3 * WINDOW + offset) * 1000)
    payload = json.loads(watch.evaluate() or "{}")
    assert payload["anomaly"] is True, payload
    assert payload["events"], "an anomaly must be recorded as an event"


def test_live_watch_stays_quiet_until_it_has_a_full_window() -> None:
    watch = LiveWatch(_config(realtime={"enabled": True, "throttleMs": 0}))
    watch.arm(signal_with_one_anomaly(), 5.0, step_ms=1000, engine="numpy")
    now = int(time.time() * 1000)
    for offset in range(5):
        watch.push("System1:X.", 1.0, now + offset * 1000)
    assert watch.evaluate() is None


# --- joint (multivariate) -------------------------------------------------------


def correlated_pair_with_a_break(seed: int = 9) -> tuple[np.ndarray, np.ndarray, int]:
    """Two signals, identical cycles in phase — except ONE cycle where the second
    is inverted. Each signal alone stays a plausible sine; the RELATION breaks."""
    rng = np.random.default_rng(seed)
    phase = np.linspace(0, 2 * np.pi, WINDOW)
    cycles = 30
    a = np.tile(np.sin(phase), cycles)
    b = np.tile(np.sin(phase), cycles)
    break_at = 17 * WINDOW
    b[break_at : break_at + WINDOW] = -np.sin(phase)
    return (
        a + rng.normal(0, 0.04, a.size),
        b + rng.normal(0, 0.04, b.size),
        break_at,
    )


def test_mstomp_reduces_to_stomp_on_one_dimension() -> None:
    series = signal_with_one_anomaly()[:800]
    p1, _ = stomp(series, WINDOW)
    p2, _ = mstomp(series[None, :], WINDOW)
    assert np.allclose(p1, p2, atol=1e-9)


def test_a_correlation_break_is_invisible_alone_and_found_jointly() -> None:
    a, b, break_at = correlated_pair_with_a_break()

    # Signal `a` alone: nothing happened to it, so nothing near the break.
    profile_a, _ = stomp(a, WINDOW)
    discords_a = find_discords(profile_a, WINDOW, 3, robust_threshold(profile_a, 3.0))
    assert all(abs(index - break_at) > 2 * WINDOW for index, _score in discords_a)

    # Jointly: the break must be the TOP discord.
    matrix = np.stack([a, b])
    profile, _ = mstomp(matrix, WINDOW)
    discords = find_discords(profile, WINDOW, 3, robust_threshold(profile, 3.0))
    assert discords, "the joint profile found nothing at all"
    assert abs(discords[0][0] - break_at) <= 2 * WINDOW, discords


def test_contributions_name_the_guilty_signal() -> None:
    """A shape injected into ONE of two signals: its share must dominate."""
    rng = np.random.default_rng(4)
    a = signal_with_one_anomaly(seed=5)
    calm = np.tile(np.sin(np.linspace(0, 2 * np.pi, WINDOW)), CYCLES)
    calm = calm + rng.normal(0, 0.05, calm.size)
    matrix = np.stack([calm, a])  # the anomaly lives in row 1

    shares = dimension_contributions(matrix, ANOMALY_AT, WINDOW)
    assert len(shares) == 2
    assert abs(sum(shares) - 1.0) < 1e-9
    assert shares[1] > shares[0], shares


def test_mass_multi_matches_the_joint_profile() -> None:
    a, b, _break_at = correlated_pair_with_a_break()
    matrix = np.stack([a, b])[:, :800]
    profile, _ = mstomp(matrix, WINDOW)
    start = 300
    distances = mass_multi(matrix[:, start : start + WINDOW], matrix, WINDOW)
    excluded = max(1, WINDOW // 4)
    distances[max(0, start - excluded) : start + excluded + 1] = np.inf
    assert abs(float(distances.min()) - float(profile[start])) < 1e-6


def test_prepare_joint_grid_spans_the_overlap_only() -> None:
    """Two elements covering shifted periods: the grid must stay inside both."""
    step = 1000
    times_a = np.arange(0, 4000 * step, step, dtype=np.int64)
    times_b = times_a + 500 * step  # starts later, ends later
    values = np.sin(np.linspace(0, 40 * np.pi, times_a.size))
    prepared = prepare(
        [(times_a, values), (times_b, values)],
        _config(dpes=["System1:A.", "System1:B."], history={"hours": 2, "maxPoints": 2000}),
    )
    assert prepared.samples.dim_count == 2
    assert prepared.samples.times[0] >= times_b[0]
    assert prepared.samples.times[-1] <= times_a[-1]


def test_joint_live_watch_flags_a_correlation_break() -> None:
    # The reference must be CLEAN: a break included in it would give the live
    # break a nearest neighbour — itself — and a comfortable score.
    rng = np.random.default_rng(11)
    phase = np.linspace(0, 2 * np.pi, WINDOW)
    a = np.tile(np.sin(phase), 30) + rng.normal(0, 0.04, 30 * WINDOW)
    b = np.tile(np.sin(phase), 30) + rng.normal(0, 0.04, 30 * WINDOW)
    reference = np.stack([a, b])
    profile, _ = mstomp(reference, WINDOW)
    threshold = robust_threshold(profile, 3.0)

    config = _config(
        dpes=["System1:A.", "System1:B."],
        realtime={"enabled": True, "bufferPoints": 500, "throttleMs": 0},
    )
    watch = LiveWatch(config)
    watch.arm(reference, threshold, step_ms=1000, engine="numpy")

    now = int(time.time() * 1000)
    cycle = np.sin(np.linspace(0, 2 * np.pi, WINDOW))
    # In-phase cycles: the familiar joint shape — under the line.
    for offset in range(2 * WINDOW):
        watch.push("System1:A.", float(cycle[offset % WINDOW]), now + offset * 1000)
        watch.push("System1:B.", float(cycle[offset % WINDOW]), now + offset * 1000)
    payload = json.loads(watch.evaluate() or "{}")
    assert payload["anomaly"] is False, payload

    # Same cycles, but B inverted: each signal alone is familiar, the pair is not.
    base = now + 2 * WINDOW * 1000
    for offset in range(2 * WINDOW):
        watch.push("System1:A.", float(cycle[offset % WINDOW]), base + offset * 1000)
        watch.push("System1:B.", float(-cycle[offset % WINDOW]), base + offset * 1000)
    payload = json.loads(watch.evaluate() or "{}")
    assert payload["anomaly"] is True, payload


def test_joint_live_watch_waits_for_every_dimension() -> None:
    """One quiet element must hold the joint score, not let the others vote."""
    config = _config(
        dpes=["System1:A.", "System1:B."],
        realtime={"enabled": True, "throttleMs": 0},
    )
    watch = LiveWatch(config)
    watch.arm(np.stack([signal_with_one_anomaly(), signal_with_one_anomaly(3)]), 5.0, 1000, "numpy")
    now = int(time.time() * 1000)
    for offset in range(3 * WINDOW):
        watch.push("System1:A.", 1.0, now + offset * 1000)  # only A speaks
    assert watch.evaluate() is None


def test_service_runs_a_joint_analysis_end_to_end() -> None:
    from signal_analytics.protocol import LEAF_COMMAND, LEAF_CONFIG
    from signal_analytics.service import SignalAnalyticsService

    a, b, break_at = correlated_pair_with_a_break()
    manager = FakeManager({"System1:SigA.": a, "System1:SigB.": b})
    service = SignalAnalyticsService(manager)
    service.start()
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not manager.connections:
            time.sleep(0.05)
        assert manager.connections, "discovery never subscribed"

        config = {
            "dpes": ["System1:SigA.", "System1:SigB."],
            "window": WINDOW,
            "engine": "numpy",
            "history": {"hours": 24, "maxPoints": 2500},
            "anomalies": {"max": 5, "sensitivity": 3.0},
            "recurrences": {"max": 3, "radius": 3.0},
            "realtime": {"enabled": False},
        }
        service._on_config("Sig_test", _event(f"Sig_test.{LEAF_CONFIG}", json.dumps(config)))
        service._on_command(
            "Sig_test",
            _event(f"Sig_test.{LEAF_COMMAND}", json.dumps({"requestId": "rj", "action": "analyze"})),
        )

        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status = manager.written.get("Sig_test.status")
            if status and json.loads(status)["state"] in ("done", "error"):
                break
            time.sleep(0.1)

        status = json.loads(manager.written["Sig_test.status"])
        assert status["state"] == "done", status
        result = json.loads(manager.written["Sig_test.result"])
        assert result["dpes"] == ["System1:SigA.", "System1:SigB."]
        assert result["anomalies"], "the correlation break must be reported"
        top = result["anomalies"][0]
        assert "contributions" in top, top
        assert set(top["contributions"]) == {"System1:SigA.", "System1:SigB."}
        # The break lives in SigB (the inverted cycle), so its share must lead.
        assert top["contributions"]["System1:SigB."] > top["contributions"]["System1:SigA."], top
    finally:
        service.stop()


# --- service ------------------------------------------------------------------


class FakeManager:
    """The slice of the WinCC OA scripting API the service actually uses.

    *series* is either one array (served for every element) or a dict keyed by
    the element name, for joint-analysis tests.
    """

    def __init__(self, series, step_ms: int = 1000) -> None:
        self.written: dict[str, str] = {}
        self.connections: dict[int, list[str]] = {}
        self._next_id = 1
        self._series = series
        self._step_ms = step_ms

    def dp_names(self, pattern: str = "", dp_type: str = "") -> list[str]:
        return ["System1:Sig_test"]

    def dp_connect(self, callback, dpes, answer: bool = True) -> int:
        connect_id = self._next_id
        self._next_id += 1
        self.connections[connect_id] = list(dpes)
        return connect_id

    def dp_disconnect(self, connect_id: int) -> None:
        self.connections.pop(connect_id, None)

    def dp_set_wait(self, dpe: str, value: str) -> None:
        self.written[dpe] = value

    def dp_get_period_split(self, start_or_id, end=None, dpes=None, count: int = 0):
        if isinstance(self._series, dict):
            requested = str(dpes[0]).split(":_", 1)[0] if dpes else ""
            series = self._series.get(requested)
            assert series is not None, f"unexpected element read: {dpes}"
        else:
            series = self._series
        base = datetime.now() - timedelta(milliseconds=self._step_ms * series.size)

        class Item:
            def __init__(self, moment: datetime, value: float) -> None:
                self.source_time = moment
                self.dp_value = value

        class Chunk:
            progress = 100
            request_id = 1

            def __init__(self, items: list[Item]) -> None:
                self.data = items

        items = [
            Item(base + timedelta(milliseconds=self._step_ms * index), float(value))
            for index, value in enumerate(series)
        ]
        return Chunk(items)


def test_service_runs_an_analysis_end_to_end() -> None:
    from signal_analytics.protocol import LEAF_COMMAND, LEAF_CONFIG
    from signal_analytics.service import SignalAnalyticsService

    manager = FakeManager(signal_with_one_anomaly())
    service = SignalAnalyticsService(manager)
    service.start()
    try:
        # Wait for discovery to subscribe to the fake datapoint.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not manager.connections:
            time.sleep(0.05)
        assert manager.connections, "discovery never subscribed"

        config = {
            "dpe": "System1:Sig_test_src.",
            "window": WINDOW,
            "engine": "numpy",
            "history": {"hours": 24, "maxPoints": 2500},
            "anomalies": {"max": 5, "sensitivity": 3.0},
            "recurrences": {"max": 3, "radius": 3.0},
            "realtime": {"enabled": False},
        }
        service._on_config("Sig_test", _event(f"Sig_test.{LEAF_CONFIG}", json.dumps(config)))
        service._on_command(
            "Sig_test",
            _event(f"Sig_test.{LEAF_COMMAND}", json.dumps({"requestId": "r1", "action": "analyze"})),
        )

        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status = manager.written.get("Sig_test.status")
            if status and json.loads(status)["state"] in ("done", "error"):
                break
            time.sleep(0.1)

        status = json.loads(manager.written["Sig_test.status"])
        assert status["state"] == "done", status
        result = json.loads(manager.written["Sig_test.result"])
        assert result["engine"] == "numpy"
        assert result["anomalies"], "the injected anomaly must be reported"
        assert result["recurrences"], "the repeated cycle must be reported"
        assert result["anomalies"][0]["end"] > result["anomalies"][0]["start"], "an anomaly has a duration"
        assert result["profile"] is not None
    finally:
        service.stop()


def _event(dp_path: str, value: str):
    """A ``dp_connect`` callback argument shaped like the real one."""

    class Item:
        def __init__(self) -> None:
            self.dp_path = dp_path
            self.dp_value = value

    class Event:
        error = None
        is_answer = False
        is_refresh = False
        values = (Item(),)

    return Event()


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
