# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""The manager's orchestration: discover signals, react, analyse, publish.

Three threads, with one rule each.

**Discovery** polls ``dp_names('*', 'SignalAnalysis')`` every
:data:`DISCOVERY_INTERVAL_S` and reconciles: a datapoint the page created gets
subscriptions, one it deleted gets them removed. Polling rather than a query
subscription because the set changes a handful of times a day and a poll cannot
be got subtly wrong.

**Subscription callbacks** (WinCC OA's own pool threads) do as little as
possible: parse the leaf, and either queue a job or push a value into the live
buffer. Nothing that can block the event manager's delivery happens here.

**One worker** drains the job queue. Analyses are serialised on purpose — they
are CPU-bound over whole arrays, and running four at once on a SCADA server
would take cores away from the processes that actually run the plant. A queued
job replaces an older pending job for the same signal, so hammering "Analyse"
costs one run, not ten.

**The hub** is the fourth path, and the only one that engineers anything: the
page cannot create datapoints, so it writes what it wants on
``SignalAnalyticsHub.request`` and this service creates or deletes it — see
:mod:`.provision`. Requests are executed on the callback thread: they are two
Event-manager calls, not a computation, and serialising them behind the analysis
worker would make the page wait on an unrelated job.

Everything the page sees is written to that signal's own leaves: ``status``
always, ``result`` on success, ``live`` on the throttle. Errors are written the
same way — a failed analysis is a state to display, not a silent log line.
"""

from __future__ import annotations

import logging
import platform
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .analysis import HistoryError, prepare, read_history
from .engines import engine_availability, resolve_engine
from .provision import ensure_hub, handle as handle_hub_request
from .protocol import (
    DP_TYPE,
    HUB_DP,
    HUB_LEAF_REQUEST,
    LEAF_COMMAND,
    LEAF_CONFIG,
    LEAF_LIVE,
    LEAF_RESULT,
    LEAF_STATUS,
    Command,
    SignalConfig,
    Status,
    parse_command,
    parse_config,
    parse_hub_request,
    result_payload,
)
from .realtime import LiveWatch

logger = logging.getLogger(__name__)

#: How often the set of ``SignalAnalysis`` datapoints is re-read.
DISCOVERY_INTERVAL_S = 10.0

#: How often live buffers are checked against their own throttle.
LIVE_TICK_S = 0.5


@dataclass
class Signal:
    """One configured signal and everything the manager holds for it."""

    dp: str
    config: SignalConfig | None = None
    watch: LiveWatch | None = None
    connect_ids: list[int] = field(default_factory=list)
    source_connects: dict[str, int] = field(default_factory=dict)
    """Live subscriptions on the analysed elements, keyed by configured name."""
    last_request: str = ""
    step_ms: int = 1000


@dataclass(frozen=True)
class Job:
    dp: str
    command: Command


class SignalAnalyticsService:
    """Wires the ``SignalAnalysis`` datapoints to the analysis engines."""

    def __init__(self, manager: Any) -> None:
        self._manager = manager
        self._signals: dict[str, Signal] = {}
        self._lock = threading.RLock()
        self._jobs: queue.Queue[Job] = queue.Queue()
        self._pending: set[str] = set()
        self._stopping = threading.Event()
        self._threads: list[threading.Thread] = []
        self._hub_connect: int | None = None
        #: Hub request ids already executed — `dp_connect(answer=True)` replays the
        #: leaf on every (re)start, and a replayed request must not run twice.
        self._hub_seen: set[str] = set()
        self._runtime = (
            f"python {platform.python_version()} / numpy {np.__version__} on {platform.node()}"
        )

    # -- lifecycle -------------------------------------------------------------

    def start(self) -> None:
        self._start_hub()
        for target, name in (
            (self._discovery_loop, "discovery"),
            (self._worker_loop, "analysis"),
            (self._live_loop, "live"),
        ):
            thread = threading.Thread(target=target, name=f"sa-{name}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        self._stopping.set()
        if self._hub_connect is not None:
            self._safe_disconnect(self._hub_connect)
            self._hub_connect = None
        with self._lock:
            for signal in self._signals.values():
                self._unsubscribe(signal)
            self._signals.clear()
        for thread in self._threads:
            thread.join(timeout=5.0)

    # -- the hub ---------------------------------------------------------------

    def _start_hub(self) -> None:
        """Provision the hub and follow its ``request`` leaf.

        A manager that cannot provision must still analyse: an installation where
        the types already exist but this manager lacks the rights to create them
        would otherwise lose the whole service over the one thing it cannot do.
        The failure is logged; the page then stays in demonstration mode, which is
        the honest reading of "no hub".
        """
        try:
            ensure_hub(self._manager, engine_availability())
        except Exception:
            logger.exception("hub provisioning failed — the page will see no manager")
            return
        try:
            self._hub_connect = self._manager.dp_connect(
                self._on_hub_request, [f"{HUB_DP}.{HUB_LEAF_REQUEST}"], True
            )
        except Exception:
            logger.exception("could not subscribe to the hub request leaf")

    def _on_hub_request(self, event: Any) -> None:
        """Execute one page request. The initial replay is adopted, not acted on."""
        if getattr(event, "is_answer", False):
            raw = self._first_value(event)
            request = parse_hub_request(str(raw or ""))
            if request is not None:
                self._hub_seen.add(request.request_id)
            return
        raw = self._first_value(event)
        request = parse_hub_request(str(raw or ""))
        if request is None:
            return
        if request.request_id in self._hub_seen:
            return
        self._hub_seen.add(request.request_id)
        handle_hub_request(self._manager, request)
        # A create means a new datapoint: reconcile now rather than up to
        # DISCOVERY_INTERVAL_S later, so the page's first read finds it subscribed.
        if request.is_create:
            try:
                self._reconcile()
            except Exception:
                logger.exception("reconcile after hub create failed")

    # -- discovery -------------------------------------------------------------

    def _discovery_loop(self) -> None:
        while not self._stopping.is_set():
            try:
                self._reconcile()
            except Exception:
                logger.exception("discovery failed")
            self._stopping.wait(DISCOVERY_INTERVAL_S)

    def _reconcile(self) -> None:
        found = {self._bare(name) for name in self._manager.dp_names("*", DP_TYPE)}
        with self._lock:
            for dp in found - self._signals.keys():
                self._add(dp)
            for dp in self._signals.keys() - found:
                self._unsubscribe(self._signals.pop(dp))
                logger.info("%s: removed", dp)

    def _add(self, dp: str) -> None:
        """Start following a datapoint: its config, its commands, its values."""
        signal = Signal(dp=dp)
        self._signals[dp] = signal
        try:
            signal.connect_ids.append(
                self._manager.dp_connect(
                    lambda event, name=dp: self._on_config(name, event), [f"{dp}.{LEAF_CONFIG}"]
                )
            )
            signal.connect_ids.append(
                self._manager.dp_connect(
                    lambda event, name=dp: self._on_command(name, event), [f"{dp}.{LEAF_COMMAND}"]
                )
            )
            logger.info("%s: following", dp)
        except Exception:
            logger.exception("%s: could not subscribe", dp)

    def _unsubscribe(self, signal: Signal) -> None:
        for connect_id in signal.connect_ids:
            self._safe_disconnect(connect_id)
        signal.connect_ids.clear()
        for connect_id in signal.source_connects.values():
            self._safe_disconnect(connect_id)
        signal.source_connects.clear()

    def _safe_disconnect(self, connect_id: int) -> None:
        try:
            self._manager.dp_disconnect(connect_id)
        except Exception:
            logger.debug("dp_disconnect(%s) failed", connect_id, exc_info=True)

    # -- callbacks -------------------------------------------------------------

    def _on_config(self, dp: str, event: Any) -> None:
        raw = self._first_value(event)
        if raw is None:
            return
        config = parse_config(dp, str(raw))
        if config is None:
            return
        with self._lock:
            signal = self._signals.get(dp)
            if signal is None:
                return
            previous = signal.config
            signal.config = config
            if (
                signal.watch is None
                or previous is None
                or previous.window != config.window
                or previous.dpes != config.dpes
            ):
                signal.watch = LiveWatch(config)
            self._bind_source(signal)

    def _on_command(self, dp: str, event: Any) -> None:
        raw = self._first_value(event)
        if raw is None:
            return
        command = parse_command(str(raw))
        if command is None:
            return
        with self._lock:
            signal = self._signals.get(dp)
            if signal is None:
                return
            # The initial `answer` callback replays whatever command was left on
            # the leaf, so a manager restart would re-run every past request.
            if command.request_id != "" and command.request_id == signal.last_request:
                return
            if getattr(event, "is_answer", False) and signal.last_request == "":
                signal.last_request = command.request_id
                return
            signal.last_request = command.request_id

        if command.is_run:
            self._enqueue(Job(dp=dp, command=command))
        elif command.action == "ping":
            self._write_status(dp, Status(state="idle", request_id=command.request_id, message="pong"))

    def _on_value(self, dp: str, dpe: str, event: Any) -> None:
        """A live value of ONE analysed element — buffer it and move on."""
        raw = self._first_value(event)
        if raw is None:
            return
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return
        with self._lock:
            signal = self._signals.get(dp)
            watch = signal.watch if signal else None
        if watch is not None:
            watch.push(dpe, value, int(time.time() * 1000))

    def _bind_source(self, signal: Signal) -> None:
        """Reconcile the live subscriptions with the configured element list.

        One ``dp_connect`` per element rather than one batched call: a batch
        fails as a whole on the first unresolvable name, and a joint signal is
        exactly where a half-typed element sneaks in next to two valid ones.
        """
        config = signal.config
        if config is None:
            return
        wanted = set(config.dpes) if config.realtime and config.is_runnable else set()

        for dpe in list(signal.source_connects):
            if dpe not in wanted:
                self._safe_disconnect(signal.source_connects.pop(dpe))
        for dpe in wanted - signal.source_connects.keys():
            try:
                signal.source_connects[dpe] = self._manager.dp_connect(
                    lambda event, name=signal.dp, element=dpe: self._on_value(name, element, event),
                    [dpe],
                )
            except Exception as error:
                logger.warning("%s: cannot follow %s (%s)", signal.dp, dpe, error)

    # -- job queue -------------------------------------------------------------

    def _enqueue(self, job: Job) -> None:
        with self._lock:
            if job.dp in self._pending:
                return
            self._pending.add(job.dp)
        self._jobs.put(job)
        self._write_status(
            job.dp, Status(state="queued", request_id=job.command.request_id, runtime=self._runtime)
        )

    def _worker_loop(self) -> None:
        while not self._stopping.is_set():
            try:
                job = self._jobs.get(timeout=0.5)
            except queue.Empty:
                continue
            with self._lock:
                self._pending.discard(job.dp)
            try:
                self._run(job)
            except Exception as error:
                logger.exception("%s: analysis crashed", job.dp)
                self._write_status(
                    job.dp,
                    Status(
                        state="error",
                        request_id=job.command.request_id,
                        message=str(error),
                        runtime=self._runtime,
                    ),
                )
            finally:
                self._jobs.task_done()

    def _run(self, job: Job) -> None:
        with self._lock:
            signal = self._signals.get(job.dp)
            config = signal.config if signal else None
        if signal is None or config is None:
            return
        if not config.is_runnable:
            self._write_status(
                job.dp,
                Status(
                    state="error",
                    request_id=job.command.request_id,
                    message="no datapoint element configured, or the signal is disabled",
                    runtime=self._runtime,
                ),
            )
            return

        engine, fallback_reason = resolve_engine(config.engine)
        started = time.monotonic()

        def progress(percent: int, message: str) -> None:
            self._write_status(
                job.dp,
                Status(
                    state="running",
                    request_id=job.command.request_id,
                    progress=percent,
                    message=message,
                    engine=engine.id,
                    engine_requested=config.engine,
                    fallback=fallback_reason != "",
                    runtime=self._runtime,
                    extras={"engines": engine_availability(), "fallbackReason": fallback_reason},
                ),
            )

        progress(5, "reading history")
        try:
            series = []
            for at, dpe in enumerate(config.dpes):
                progress(5 + int(10 * at / max(1, len(config.dpes))), f"reading {dpe}")
                series.append(read_history(self._manager, config, dpe))
            prepared = prepare(series, config)
        except HistoryError as error:
            self._write_status(
                job.dp,
                Status(
                    state="error",
                    request_id=job.command.request_id,
                    message=str(error),
                    engine=engine.id,
                    engine_requested=config.engine,
                    runtime=self._runtime,
                ),
            )
            return

        result = engine.analyse(prepared.samples, config, progress)
        duration_ms = int((time.monotonic() - started) * 1000)
        notes = prepared.notes + result.notes
        if fallback_reason:
            notes.append(f"fell back to {engine.id}: {fallback_reason}")

        self._write(
            config.leaf(LEAF_RESULT),
            result_payload(
                config,
                job.command.request_id,
                engine.id,
                result.anomalies,
                result.recurrences,
                sample_count=prepared.samples.size,
                span=prepared.samples.span,
                profile=result.profile,
                duration_ms=duration_ms,
                threshold=result.threshold,
                notes=notes,
            ),
        )

        with self._lock:
            signal.step_ms = prepared.step_ms
            watch = signal.watch
        if watch is not None and result.reference is not None and np.isfinite(result.threshold):
            watch.arm(result.reference, result.threshold, prepared.step_ms, engine.id)

        self._write_status(
            job.dp,
            Status(
                state="done",
                request_id=job.command.request_id,
                progress=100,
                message=f"{len(result.anomalies)} anomalies, {len(result.recurrences)} recurrences",
                engine=engine.id,
                engine_requested=config.engine,
                fallback=fallback_reason != "",
                runtime=self._runtime,
                extras={
                    "engines": engine_availability(),
                    "fallbackReason": fallback_reason,
                    "durationMs": duration_ms,
                    "stepMs": prepared.step_ms,
                    "rawCount": prepared.raw_count,
                    "sampleCount": prepared.samples.size,
                },
            ),
        )

    # -- live ------------------------------------------------------------------

    def _live_loop(self) -> None:
        while not self._stopping.is_set():
            try:
                self._publish_live()
            except Exception:
                logger.exception("live publication failed")
            self._stopping.wait(LIVE_TICK_S)

    def _publish_live(self) -> None:
        with self._lock:
            watches = [
                (signal.dp, signal.watch, signal.config)
                for signal in self._signals.values()
                if signal.watch is not None and signal.config is not None
            ]
        for dp, watch, config in watches:
            if watch is None or not config.realtime or not watch.armed or not watch.due():
                continue
            payload = watch.evaluate()
            if payload is not None:
                self._write(f"{dp}.{LEAF_LIVE}", payload)

    # -- datapoint I/O ---------------------------------------------------------

    def _write_status(self, dp: str, status: Status) -> None:
        self._write(f"{dp}.{LEAF_STATUS}", status.to_json())

    def _write(self, dpe: str, value: str) -> None:
        try:
            self._manager.dp_set_wait(dpe, value)
        except Exception as error:
            logger.warning("write to %s failed: %s", dpe, error)

    @staticmethod
    def _first_value(event: Any) -> Any:
        """The single value of a one-element ``dp_connect`` callback, or ``None``."""
        if getattr(event, "error", None) is not None:
            return None
        values = getattr(event, "values", None)
        if not values:
            single = getattr(event, "value", None)
            values = [single] if single is not None else None
        if not values:
            return None
        raw = getattr(values[0], "dp_value", None)
        return getattr(raw, "value", raw)

    @staticmethod
    def _bare(name: str) -> str:
        """Drop a leading ``System1:`` so names compare against what the page wrote."""
        return name.split(":", 1)[1] if ":" in name else name
