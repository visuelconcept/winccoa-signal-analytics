# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Engine registry and the fallback rule.

The page offers a choice of engine; two of the three are optional installs. The
rule when the chosen one is missing is *degrade, never fail*: analyse with the
built-in NumPy engine, and report both what was asked for and why it could not
be honoured, so the page can say "ran on numpy — stumpy is not installed" rather
than showing an empty result and an error.
"""

from __future__ import annotations

from .base import Engine, EngineResult, ProgressFn, Samples
from .chronos import ChronosEngine
from .matrix import NumpyEngine, StumpyEngine

__all__ = [
    "Engine",
    "EngineResult",
    "ProgressFn",
    "Samples",
    "engine_availability",
    "resolve_engine",
]

_ENGINES: dict[str, Engine] = {
    NumpyEngine.id: NumpyEngine(),
    StumpyEngine.id: StumpyEngine(),
    ChronosEngine.id: ChronosEngine(),
}

#: Always installed, so it is what everything else falls back to.
_FALLBACK = NumpyEngine.id


def resolve_engine(requested: str) -> tuple[Engine, str]:
    """The engine to actually run, plus the reason it is not the requested one.

    The reason is empty when the request was honoured.
    """
    engine = _ENGINES.get(requested)
    if engine is None:
        return _ENGINES[_FALLBACK], f"unknown engine '{requested}'"

    usable, reason = engine.available()
    if usable:
        return engine, ""
    return _ENGINES[_FALLBACK], reason


def engine_availability() -> dict[str, dict[str, object]]:
    """Which engines this manager can run — published on every status write."""
    report: dict[str, dict[str, object]] = {}
    for identifier, engine in _ENGINES.items():
        usable, reason = engine.available()
        report[identifier] = {"available": usable, "reason": reason}
    return report
