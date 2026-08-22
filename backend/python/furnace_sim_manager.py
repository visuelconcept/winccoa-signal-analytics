# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Furnace simulator — WinCC OA **Python manager** (entry point).

Creates and drives a simulated batch furnace so the ``/signal-analytics`` page
has something real to analyse: three correlated, NGA-archived elements
(``SigSim_Furnace01.temperature`` / ``.power`` / ``.gasFlow``) with anomalies
injected on a **known, published schedule** — which is what makes the detection
*verifiable* rather than merely plausible.

Registered in ``<project>/config/progs`` as::

    python | always | 30 | 2 | 2 |furnace_sim_manager.py -num 61

On every start (all idempotent — a restart continues, it never duplicates):

1. create the ``SigSim_Furnace`` DP type and its instance when missing;
2. find the first active non-alert NGA archive group (the ``EVENT`` group of a
   fresh project, by preference) and declare value archiving on each element —
   **no group, no simulator**: without archiving there is nothing to analyse,
   so that case is a loud log line and a clean stop, not a silent demo;
3. backfill the missing history (default 6 h, ``SIM_BACKFILL_HOURS`` overrides)
   through ``dp_set_timed_wait`` with past source times;
4. write the injected-anomaly schedule to ``SigSim_Furnace01.info`` (JSON) —
   overheats are visible on the temperature alone, correlation breaks only
   exist jointly;
5. keep driving the three elements live, one sample every 5 s, on the same
   deterministic time function the backfill used — past and present are one
   continuous process.

The process model lives in ``furnace_sim/process.py`` (pure arithmetic, tested
without WinCC OA); the provisioning in ``furnace_sim/provision.py``.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from etm.wccoa.manager import Manager  # noqa: E402

from furnace_sim.process import sample_at  # noqa: E402
from furnace_sim.provision import (  # noqa: E402
    SAMPLE_INTERVAL_S,
    backfill,
    element_dpes,
    ensure_archiving,
    ensure_datapoint,
    find_archive_group,
    publish_schedule,
)

logger = logging.getLogger("furnace_sim")

#: Hours of history written on first start (env-overridable for demos).
DEFAULT_BACKFILL_HOURS = 6.0


def main() -> None:
    hours = float(os.environ.get("SIM_BACKFILL_HOURS", DEFAULT_BACKFILL_HOURS))

    with Manager() as manager:
        ensure_datapoint(manager)

        group = find_archive_group(manager)
        if group is None:
            logger.error(
                "no active NGA value-archive group in this project — nothing would be "
                "archived, so nothing could be analysed; start an NGA archive group and "
                "restart this manager"
            )
            return
        ensure_archiving(manager, group)

        now_ms = int(time.time() * 1000)
        span_start, written = backfill(manager, hours, now_ms)
        publish_schedule(manager, span_start, now_ms)
        logger.info(
            "furnace ready: archive group %s, %d samples backfilled, driving live", group, written
        )

        # The live loop: the same time function as the backfill, sampled on a
        # 5 s beat aligned to the clock, so a manager restart resumes the very
        # sequence it left — no seam in the curve, no seam in the archive.
        dpes = element_dpes()
        while True:
            beat = (int(time.time()) // SAMPLE_INTERVAL_S + 1) * SAMPLE_INTERVAL_S
            time.sleep(max(0.0, beat - time.time()))
            values = sample_at(float(beat)).as_tuple()
            try:
                manager.dp_set_timed(
                    datetime.fromtimestamp(float(beat)).astimezone(), list(dpes), list(values)
                )
            except Exception as error:
                logger.warning("live write failed: %s", error)


if __name__ == "__main__":
    main()
