# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Signal Analytics — WinCC OA **Python manager** (entry point).

Analyses the datapoint elements configured by the ``/signal-analytics`` WebUI page
and writes back the anomalies and the recurrences it finds, on the historical
window and then continuously on the live values.

Registered in ``<project>/config/progs`` as::

    python | always | 30 | 2 | 2 |signal_analytics_manager.py -num 60

The whole exchange with the page goes through ONE datapoint per configured signal
(DP type ``SignalAnalysis``) — the Python API is a scripting API, it hosts no MSA
vRPC service, so a webserver route could not call into this process. See
``signal_analytics/protocol.py`` for the JSON written on each leaf.

The script keeps itself alive (it only subscribes); PMON stops it with SIGTERM,
which ``Manager.start()`` turns into a clean shutdown of the ``with`` block.
"""

from __future__ import annotations

import logging
import os
import sys
import threading

# PMON launches the script by its resolved path, so CPython normally puts
# `<project>/python` on sys.path itself. Doing it explicitly costs nothing and
# makes the script importable the same way when it is started by hand for a test.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from etm.wccoa.manager import Manager  # noqa: E402

from signal_analytics.service import SignalAnalyticsService  # noqa: E402

logger = logging.getLogger("signal_analytics")


def main() -> None:
    with Manager() as manager:
        service = SignalAnalyticsService(manager)
        service.start()
        logger.info("Signal Analytics manager ready")
        try:
            # Blocks until SIGTERM/SIGINT — see the Manager guide, "Keeping the
            # Script Running". Everything from here on happens in callbacks and
            # in the analysis worker thread.
            threading.Event().wait()
        finally:
            service.stop()


if __name__ == "__main__":
    main()
