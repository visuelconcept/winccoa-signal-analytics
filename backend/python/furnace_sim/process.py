# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""The simulated furnace, as pure arithmetic: time in → three values out.

Everything the simulator writes into WinCC OA comes from :func:`sample_at`,
which is a *function of absolute time* — deterministic per timestamp, no state
carried between calls. That one property is what makes the whole demo
verifiable: the history backfill and the live loop call the same function, so
the archived past and the streaming present are one continuous process; and the
anomaly schedule is computed, not drawn, so a test (or a person) can say in
advance where the analysis MUST find something.

**The process.** A batch furnace on a fixed cycle (:data:`CYCLE_S`): ramp up,
soak, cool, idle. Three correlated signals —

- ``temperature`` follows the batch profile (a first-order-ish response to it);
- ``power`` leads it: high on the ramp, holding level on the soak, near zero
  during cooling and idle;
- ``gasFlow`` tracks power with its own gain and noise.

**The injected anomalies**, one of each kind per :data:`ANOMALY_EVERY_CYCLES`
cycles, phase-locked to the cycle counter:

- an **overheat** — the soak runs ~18 % hot. Visible on the temperature alone:
  the classic univariate discord.
- a **correlation break** — power collapses mid-ramp while the temperature keeps
  climbing on schedule (a stuck sensor, a wrong feedback). Each signal alone
  stays a plausible curve; only the *pair* is wrong. This is the case that
  justifies the joint (multivariate) analysis, and the simulator exists largely
  to demonstrate it.

The noise is deterministic too — a hash of the sample's timestamp seeds it — so
replaying a timestamp replays its value exactly.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

#: One batch cycle, in seconds: 3 min ramp + 3 min soak + 2 min cool + 2 min idle.
CYCLE_S = 600

#: Phase boundaries inside a cycle, in seconds from its start.
RAMP_END_S = 180
SOAK_END_S = 360
COOL_END_S = 480

#: Ambient and soak temperatures (°C).
AMBIENT_C = 40.0
SOAK_C = 850.0

#: Power (kW) on the ramp and holding the soak.
RAMP_KW = 120.0
SOAK_KW = 45.0

#: Gas flow gain (m³/h per kW) — flow is essentially power seen by another meter.
FLOW_PER_KW = 0.42

#: One anomaly of each kind per this many cycles.
ANOMALY_EVERY_CYCLES = 12

#: Cycle offsets (within each block of ANOMALY_EVERY_CYCLES) carrying an anomaly.
OVERHEAT_CYCLE_OFFSET = 4
BREAK_CYCLE_OFFSET = 9

#: The overheat: the soak setpoint, multiplied.
OVERHEAT_FACTOR = 1.18

#: The correlation break: power collapses over this stretch of the ramp.
BREAK_START_S = 60
BREAK_END_S = 160

#: Relative measurement noise per signal.
TEMPERATURE_NOISE = 0.006
POWER_NOISE = 0.02
FLOW_NOISE = 0.03

#: The three elements of the simulated DP, in the order `sample_at` returns them.
ELEMENTS = ("temperature", "power", "gasFlow")


@dataclass(frozen=True)
class FurnaceSample:
    """One instant of the simulated furnace."""

    temperature: float
    power: float
    gas_flow: float

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.temperature, self.power, self.gas_flow)


@dataclass(frozen=True)
class InjectedAnomaly:
    """One scheduled anomaly — where a correct analysis must find something."""

    kind: str
    """``overheat`` (univariate) or ``correlation-break`` (joint-only)."""

    start_ms: int
    end_ms: int


def _noise(timestamp_s: float, channel: str, scale: float) -> float:
    """Deterministic noise in ``[-scale, +scale]``, seeded by (timestamp, channel).

    A hash rather than a seeded generator so any single timestamp can be
    recomputed in isolation — the backfill and the live loop never have to agree
    on a generator state, only on the clock.
    """
    digest = hashlib.blake2b(
        f"{channel}:{int(timestamp_s)}".encode(), digest_size=8
    ).digest()
    unit = int.from_bytes(digest, "big") / float(1 << 64)
    return (unit * 2.0 - 1.0) * scale


def cycle_index(timestamp_s: float) -> int:
    return int(timestamp_s // CYCLE_S)


def _has_overheat(cycle: int) -> bool:
    return cycle % ANOMALY_EVERY_CYCLES == OVERHEAT_CYCLE_OFFSET


def _has_break(cycle: int) -> bool:
    return cycle % ANOMALY_EVERY_CYCLES == BREAK_CYCLE_OFFSET


def _base_profile(phase_s: float, soak_c: float) -> tuple[float, float]:
    """(temperature, power) of a healthy cycle at *phase_s* seconds in."""
    if phase_s < RAMP_END_S:
        progress = phase_s / RAMP_END_S
        # An exponential-ish approach reads as thermal mass; linear reads as fake.
        temperature = AMBIENT_C + (soak_c - AMBIENT_C) * (1.0 - math.exp(-3.0 * progress)) / (
            1.0 - math.exp(-3.0)
        )
        power = RAMP_KW
    elif phase_s < SOAK_END_S:
        temperature = soak_c
        power = SOAK_KW
    elif phase_s < COOL_END_S:
        progress = (phase_s - SOAK_END_S) / (COOL_END_S - SOAK_END_S)
        temperature = AMBIENT_C + (soak_c - AMBIENT_C) * math.exp(-4.0 * progress)
        power = 0.0
    else:
        temperature = AMBIENT_C
        power = 0.0
    return temperature, power


def sample_at(timestamp_s: float) -> FurnaceSample:
    """The furnace at an absolute instant (epoch seconds, local or UTC alike)."""
    cycle = cycle_index(timestamp_s)
    phase_s = timestamp_s - cycle * CYCLE_S

    soak_c = SOAK_C * (OVERHEAT_FACTOR if _has_overheat(cycle) else 1.0)
    temperature, power = _base_profile(phase_s, soak_c)

    # The correlation break: power collapses mid-ramp, temperature does NOT —
    # each curve alone still looks like a furnace, together they are impossible.
    if _has_break(cycle) and BREAK_START_S <= phase_s < BREAK_END_S:
        power *= 0.12

    gas_flow = power * FLOW_PER_KW

    return FurnaceSample(
        temperature=round(temperature * (1.0 + _noise(timestamp_s, "t", TEMPERATURE_NOISE)), 3),
        power=round(max(0.0, power * (1.0 + _noise(timestamp_s, "p", POWER_NOISE))), 3),
        gas_flow=round(max(0.0, gas_flow * (1.0 + _noise(timestamp_s, "g", FLOW_NOISE))), 3),
    )


def scheduled_anomalies(start_ms: int, end_ms: int) -> list[InjectedAnomaly]:
    """Every anomaly the schedule places inside ``[start_ms, end_ms]``.

    This is the verification half of the simulator: the page's findings can be
    read against this list, and the docs' claim "the analysis finds the injected
    anomalies" becomes checkable instead of rhetorical.
    """
    found: list[InjectedAnomaly] = []
    first = cycle_index(start_ms / 1000.0)
    last = cycle_index(end_ms / 1000.0)
    for cycle in range(first, last + 1):
        base_s = cycle * CYCLE_S
        if _has_overheat(cycle):
            begin = (base_s + RAMP_END_S) * 1000
            finish = (base_s + SOAK_END_S) * 1000
            if finish >= start_ms and begin <= end_ms:
                found.append(InjectedAnomaly("overheat", begin, finish))
        if _has_break(cycle):
            begin = (base_s + BREAK_START_S) * 1000
            finish = (base_s + BREAK_END_S) * 1000
            if finish >= start_ms and begin <= end_ms:
                found.append(InjectedAnomaly("correlation-break", begin, finish))
    return found
