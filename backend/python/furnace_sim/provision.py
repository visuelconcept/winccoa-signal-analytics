# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Provisioning: the datapoints, their archiving, and the history backfill.

Everything here is **idempotent** — the manager runs it on every start, and a
restart must find the world already in order rather than double it:

- the DP type and the datapoint are created only if absent;
- archiving is (re)declared on each element — WinCC OA treats a repeated config
  write as an update, not an error;
- the backfill first asks the archive what it already holds and only writes the
  span that is actually missing, so a restart continues history instead of
  re-inserting six hours of duplicates.

**Archive group discovery.** The value archive to assign is not hardcoded: the
project's ``_NGA_Group`` instances are listed, filtered to active non-alert
groups (their ``_2`` redundancy twins excluded), and the one named ``EVENT`` is
preferred when present — that is the group a fresh WinCC OA project ships with.
The archive-config attribute values (DPCONFIG 45 / DPATTR 15) mirror the proven
``wui-para`` archive logic; see ``libs/wui-audit-trail/src/audit-trail/dp-admin.ts``.

**Backfill mechanics.** ``dp_set_timed_wait`` with past source times: values
flow through the Event manager stamped with the instant they *describe*, and NGA
archives them under that instant. Written oldest-first in modest batches so the
Event manager sees a steady stream, not one multi-megabyte request.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from .process import ELEMENTS, sample_at, scheduled_anomalies

logger = logging.getLogger(__name__)

#: The simulated device's DP type and instance.
DP_TYPE = "SigSim_Furnace"
DP_NAME = "SigSim_Furnace01"

#: Extra String leaf carrying the injection schedule — the verification data.
INFO_ELEMENT = "info"

#: WinCC OA archive-config constants (CTRL DPCONFIG/DPATTR values).
ARCHIVE_INFO = 45  # DPCONFIG_DB_ARCHIVEINFO
ARCH_PROC_VALARCH = 15  # DPATTR_ARCH_PROC_VALARCH (NGA value archive)

#: Samples written per dp_set_timed_wait during the backfill.
BACKFILL_BATCH = 120

#: Seconds between two simulated samples (backfill and live alike).
SAMPLE_INTERVAL_S = 5


def element_dpes(system: str = "") -> list[str]:
    """The three analysable elements, optionally system-prefixed."""
    prefix = f"{system}:" if system else ""
    return [f"{prefix}{DP_NAME}.{element}" for element in ELEMENTS]


def _bare(name: str) -> str:
    return name.split(":", 1)[1] if ":" in name else name


def _flag(value: Any) -> bool:
    unwrapped = getattr(value, "value", value)
    if isinstance(unwrapped, bool):
        return unwrapped
    return str(unwrapped).strip().lower() in ("1", "true")


def find_archive_group(manager: Any) -> str | None:
    """The NGA value-archive group to assign — ``None`` when the project has none.

    Preference order: a group whose name contains ``EVENT`` (the default group of
    a fresh project), else the first active non-alert group alphabetically.
    """
    names = sorted(_bare(name) for name in manager.dp_names("*", "_NGA_Group"))
    candidates: list[str] = []
    for name in names:
        if name == "" or name.endswith("_2"):
            continue
        try:
            active = _flag(manager.dp_get(f"{name}.active"))
            is_alert = _flag(manager.dp_get(f"{name}.isAlert"))
        except Exception:
            continue
        if active and not is_alert:
            candidates.append(name)
    if not candidates:
        return None
    for name in candidates:
        if "EVENT" in name.upper():
            return name
    return candidates[0]


def ensure_datapoint(manager: Any) -> None:
    """Create the DP type and the instance when missing.

    The type-definition shapes follow the installed example
    (``api.python/examples/scripting_hello``): an ``OaDpTypeDefinition``
    STRUCTURE root with one FLOAT leaf per signal, plus a STRING leaf for the
    injection schedule. Imported lazily so the pure-arithmetic modules stay
    importable without a WinCC OA installation (the tests need exactly that).
    """
    from etm.wccoa.services.data import OaDpTypeDefinition, OaElementType

    if DP_TYPE not in set(manager.dp_types(DP_TYPE)):
        definition = OaDpTypeDefinition(name=DP_TYPE, element_type=OaElementType.STRUCTURE)
        for element in ELEMENTS:
            definition.add_leaf(element, OaElementType.FLOAT)
        definition.add_leaf(INFO_ELEMENT, OaElementType.STRING)
        manager.dp_type_create(definition)
        logger.info("created DP type %s", DP_TYPE)
    if not manager.dp_exists(f"{DP_NAME}."):
        manager.dp_create(DP_NAME, DP_TYPE)
        logger.info("created datapoint %s", DP_NAME)


def ensure_archiving(manager: Any, group: str) -> None:
    """Declare NGA value archiving with *group* on every FLOAT element."""
    for element in ELEMENTS:
        dpe = f"{DP_NAME}.{element}"
        manager.dp_set_wait(
            [
                f"{dpe}:_archive.._type",
                f"{dpe}:_archive.._archive",
                f"{dpe}:_archive.1._type",
                f"{dpe}:_archive.1._class",
            ],
            [ARCHIVE_INFO, True, ARCH_PROC_VALARCH, group],
        )
    logger.info("archiving on %s.* -> group %s", DP_NAME, group)


def last_archived_ms(manager: Any) -> int | None:
    """Newest archived instant of the temperature element, or ``None``."""
    end = datetime.now().astimezone()
    start = end - timedelta(days=2)
    try:
        result = manager.dp_get_period(start, end, [f"{DP_NAME}.{ELEMENTS[0]}:_original.._value"])
        newest: int | None = None
        for item in result:
            at = int(item.source_time.timestamp() * 1000)
            if newest is None or at > newest:
                newest = at
    except Exception:
        return None
    return newest


def backfill(manager: Any, hours: float, now_ms: int) -> tuple[int, int]:
    """Write the missing history, oldest first. Returns ``(from_ms, written)``.

    The span starts at ``now - hours`` or just after the newest value already
    archived, whichever is later — a restart therefore fills the gap since the
    manager last ran, and nothing else.
    """
    span_start = now_ms - int(hours * 3600 * 1000)
    already = last_archived_ms(manager)
    if already is not None:
        span_start = max(span_start, already + SAMPLE_INTERVAL_S * 1000)
    if span_start >= now_ms:
        return span_start, 0

    dpes = element_dpes()
    written = 0
    batch_times: list[int] = []
    for at_ms in range(span_start, now_ms, SAMPLE_INTERVAL_S * 1000):
        batch_times.append(at_ms)
        if len(batch_times) >= BACKFILL_BATCH:
            written += _write_batch(manager, dpes, batch_times)
            batch_times = []
    if batch_times:
        written += _write_batch(manager, dpes, batch_times)
    logger.info("backfilled %d samples from %s", written, datetime.fromtimestamp(span_start / 1000))
    return span_start, written


def _write_batch(manager: Any, dpes: list[str], times_ms: list[int]) -> int:
    for at_ms in times_ms:
        values = sample_at(at_ms / 1000.0).as_tuple()
        manager.dp_set_timed_wait(
            datetime.fromtimestamp(at_ms / 1000.0).astimezone(), list(dpes), list(values)
        )
    return len(times_ms)


def publish_schedule(manager: Any, from_ms: int, to_ms: int) -> None:
    """Write the injected-anomaly schedule to the ``info`` leaf.

    THE verification artefact: the page's findings can be read against it, per
    kind — the overheats should surface even univariate, the correlation breaks
    only when the three elements are analysed jointly.
    """
    anomalies = scheduled_anomalies(from_ms, to_ms)
    payload = {
        "device": DP_NAME,
        "elements": element_dpes(),
        "cycleS": 600,
        "injected": [
            {"kind": item.kind, "start": item.start_ms, "end": item.end_ms} for item in anomalies
        ],
        "note": (
            "overheat anomalies are visible on the temperature alone; "
            "correlation-break anomalies only exist jointly (power vs temperature)"
        ),
    }
    manager.dp_set_wait(f"{DP_NAME}.{INFO_ELEMENT}", json.dumps(payload, separators=(",", ":")))
