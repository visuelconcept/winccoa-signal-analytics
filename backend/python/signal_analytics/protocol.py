# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""The contract between the WebUI page and this manager.

One WinCC OA datapoint of type ``SignalAnalysis`` per configured signal. Six
String leaves, three written by each side — no leaf is ever written by both, so
neither side can clobber the other:

===============  ==========  =================================================
Leaf             Written by  Content
===============  ==========  =================================================
``name``         page        display label (also the DP's human name)
``config``       page        :class:`SignalConfig` — what to analyse and how
``command``      page        :class:`Command` — "analyse now", "cancel", "ping"
``status``       manager     :class:`Status` — state/progress of the last command
``result``       manager     historical findings (see :func:`result_payload`)
``live``         manager     rolling real-time findings
===============  ==========  =================================================

Values are JSON objects encoded as strings. The page reads through
``_online.._value``; this side writes with ``dp_set_wait``, which targets
``_original.._value`` — the standard WinCC OA completion, nothing special.

**The series itself is never sent.** The page reads the same period with
``dpGetPeriod`` for its chart, so shipping it a second time would only inflate a
String DPE by a few hundred kilobytes. Findings carry absolute timestamps and so
line up with the page's own curve by construction.

The TypeScript mirror of these shapes is
``libs/wui-signal-analytics/src/signal-analytics/types.ts`` — keep the two in
step, they are one contract seen from either end.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

#: DP type created by the page (through the PARA REST API) and read here.
DP_TYPE = "SignalAnalysis"

#: Leaves of :data:`DP_TYPE`.
LEAF_NAME = "name"
LEAF_CONFIG = "config"
LEAF_COMMAND = "command"
LEAF_STATUS = "status"
LEAF_RESULT = "result"
LEAF_LIVE = "live"

#: Joint analyses are capped: every dimension multiplies the O(n²) work, and
#: past a handful of signals the mean-aggregated profile dilutes any single
#: signal's contribution into invisibility anyway.
MAX_DIMENSIONS = 8

#: Engine ids the page may request. ``numpy`` is always available.
ENGINE_NUMPY = "numpy"
ENGINE_STUMPY = "stumpy"
ENGINE_CHRONOS = "chronos"
ENGINES = (ENGINE_NUMPY, ENGINE_STUMPY, ENGINE_CHRONOS)


def now_iso() -> str:
    """Current instant as an ISO-8601 string with an explicit UTC offset."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def to_epoch_ms(moment: datetime) -> int:
    """A datetime (a naive one is read as local time) as epoch milliseconds."""
    if moment.tzinfo is None:
        moment = moment.astimezone()
    return int(moment.timestamp() * 1000)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _as_int(raw: Any, default: int, low: int, high: int) -> int:
    try:
        return int(_clamp(float(raw), low, high))
    except (TypeError, ValueError):
        return default


def _as_float(raw: Any, default: float, low: float, high: float) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(value) else _clamp(value, low, high)


def _as_bool(raw: Any, default: bool) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(raw, (int, float)):
        return raw != 0
    return default


@dataclass(frozen=True)
class SignalConfig:
    """What the page asked to analyse, already validated and clamped.

    Every field is bounded here rather than trusted: the JSON comes from a
    browser, and a window of 0 or a history of 400 days would either divide by
    zero or read the archive until PMON kills the manager.
    """

    dp: str
    """Backing datapoint of this configuration (a ``SignalAnalysis`` instance)."""

    dpes: tuple[str, ...]
    """The analysed datapoint elements. One = univariate; several = ONE joint
    analysis over all of them (mSTAMP), not N separate ones — the point of the
    list is anomalies that only exist in the correlation between signals."""

    label: str = ""
    enabled: bool = True
    engine: str = ENGINE_NUMPY

    window: int = 64
    """Subsequence length *m*, in samples: the length of the shape looked for."""

    history_hours: float = 24.0
    max_points: int = 20000
    """The analysis is downsampled to this many points — see :mod:`.analysis`."""

    max_anomalies: int = 10
    sensitivity: float = 3.0
    """Anomaly threshold in robust sigmas (median + k·MAD) over the profile."""

    max_recurrences: int = 5
    recurrence_radius: float = 3.0
    """A motif keeps the occurrences within *radius* × its own pair distance."""

    realtime: bool = True
    buffer_points: int = 2000
    throttle_ms: int = 5000

    chronos_model: str = "amazon/chronos-bolt-small"
    chronos_context: int = 512
    chronos_horizon: int = 32

    @property
    def is_runnable(self) -> bool:
        return self.enabled and len(self.dpes) > 0

    @property
    def dpe(self) -> str:
        """The first element — for messages and univariate fallbacks."""
        return self.dpes[0] if self.dpes else ""

    def leaf(self, leaf: str) -> str:
        return f"{self.dp}.{leaf}"

    def period(self) -> tuple[datetime, datetime]:
        """The historical window to read, ending now."""
        end = datetime.now().astimezone()
        return end - timedelta(hours=self.history_hours), end


def parse_config(dp: str, raw: str) -> SignalConfig | None:
    """Parse a ``config`` leaf. Returns ``None`` when it holds no usable JSON."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None

    history = data.get("history") if isinstance(data.get("history"), dict) else {}
    anomalies = data.get("anomalies") if isinstance(data.get("anomalies"), dict) else {}
    recurrences = data.get("recurrences") if isinstance(data.get("recurrences"), dict) else {}
    realtime = data.get("realtime") if isinstance(data.get("realtime"), dict) else {}
    chronos = data.get("chronos") if isinstance(data.get("chronos"), dict) else {}

    engine = str(data.get("engine") or ENGINE_NUMPY).strip().lower()
    if engine not in ENGINES:
        engine = ENGINE_NUMPY

    # `dpes` (list) is the current form; a lone `dpe` string is the pre-multivariate
    # config leaf, still valid — configs are data at rest, not code to migrate.
    raw_dpes = data.get("dpes")
    if isinstance(raw_dpes, list):
        dpes = tuple(str(item).strip() for item in raw_dpes if str(item).strip() != "")
    else:
        single = str(data.get("dpe") or "").strip()
        dpes = (single,) if single != "" else ()

    return SignalConfig(
        dp=dp,
        dpes=dpes[:MAX_DIMENSIONS],
        label=str(data.get("label") or ""),
        enabled=_as_bool(data.get("enabled"), True),
        engine=engine,
        window=_as_int(data.get("window"), 64, 4, 5000),
        history_hours=_as_float(history.get("hours"), 24.0, 0.1, 24 * 90),
        max_points=_as_int(history.get("maxPoints"), 20000, 200, 200000),
        max_anomalies=_as_int(anomalies.get("max"), 10, 1, 200),
        sensitivity=_as_float(anomalies.get("sensitivity"), 3.0, 0.5, 20.0),
        max_recurrences=_as_int(recurrences.get("max"), 5, 1, 50),
        recurrence_radius=_as_float(recurrences.get("radius"), 3.0, 1.0, 20.0),
        realtime=_as_bool(realtime.get("enabled"), True),
        buffer_points=_as_int(realtime.get("bufferPoints"), 2000, 50, 100000),
        throttle_ms=_as_int(realtime.get("throttleMs"), 5000, 250, 600000),
        chronos_model=str(chronos.get("model") or "amazon/chronos-bolt-small"),
        chronos_context=_as_int(chronos.get("context"), 512, 32, 8192),
        chronos_horizon=_as_int(chronos.get("horizon"), 32, 4, 512),
    )


@dataclass(frozen=True)
class Command:
    """A ``command`` leaf: what the page last asked for."""

    request_id: str
    action: str
    issued_at: str = ""
    user: str = ""

    @property
    def is_run(self) -> bool:
        return self.action in ("analyze", "analyse", "run")


def parse_command(raw: str) -> Command | None:
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    action = str(data.get("action") or "").strip().lower()
    if action == "":
        return None
    return Command(
        request_id=str(data.get("requestId") or ""),
        action=action,
        issued_at=str(data.get("issuedAt") or ""),
        user=str(data.get("user") or ""),
    )


@dataclass
class Status:
    """A ``status`` leaf: what the manager is doing with the last command."""

    state: str = "idle"
    request_id: str = ""
    progress: int = 0
    message: str = ""
    engine: str = ""
    engine_requested: str = ""
    fallback: bool = False
    runtime: str = ""
    extras: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        payload: dict[str, Any] = {
            "state": self.state,
            "requestId": self.request_id,
            "progress": self.progress,
            "message": self.message,
            "engine": self.engine,
            "engineRequested": self.engine_requested,
            "fallback": self.fallback,
            "runtime": self.runtime,
            "updatedAt": now_iso(),
        }
        payload.update(self.extras)
        return json.dumps(payload, separators=(",", ":"))


def result_payload(
    config: SignalConfig,
    request_id: str,
    engine: str,
    anomalies: list[dict[str, Any]],
    recurrences: list[dict[str, Any]],
    *,
    sample_count: int,
    span: tuple[int, int],
    profile: dict[str, Any] | None,
    duration_ms: int,
    threshold: float,
    notes: list[str],
) -> str:
    """Serialise the historical findings written on the ``result`` leaf."""
    return json.dumps(
        {
            "requestId": request_id,
            "dpe": config.dpe,
            "dpes": list(config.dpes),
            "engine": engine,
            "window": config.window,
            "sampleCount": sample_count,
            "from": span[0],
            "to": span[1],
            "threshold": threshold,
            "anomalies": anomalies,
            "recurrences": recurrences,
            "profile": profile,
            "notes": notes,
            "computedAt": now_iso(),
            "durationMs": duration_ms,
        },
        separators=(",", ":"),
    )
