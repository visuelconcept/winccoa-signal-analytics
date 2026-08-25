# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Provisioning: the DP types, the hub, and the datapoints the page asks for.

**Why this module exists.** The page cannot create datapoints. The WebUI runtime
API (``OaRxJsApi``) reads, subscribes and writes *values* — there is no
``dpCreate`` and no ``dpTypeCreate`` in it, and the standard webserver exposes no
engineering route either. Creating a datapoint is a manager's job, and this is the
manager. So the page asks over one hub datapoint and this module engineers.

Everything here is **idempotent** — the manager runs :func:`ensure_hub` on every
start, and a restart must find the world already in order rather than double it.

**The hub.** ``SignalAnalyticsHub`` carries three String leaves: ``request``
(page → here), ``response`` (here → page, echoing the request id) and ``info``
(this manager's identity card, written on start). The page's very first read is
``info``: no hub means no manager was ever started against this project, which is
exactly when the page should say it is in demonstration mode.

**What is refused.** Every name the page proposes goes through
:func:`~.protocol.safe_dp_name` first, and a request is refused — with a readable
reason on ``response`` — rather than guessed at:

- a name that reduces to nothing usable;
- a ``delete`` of a datapoint that is not one of ours (the prefix is the fence:
  this manager will not delete a datapoint it did not create);
- a ``create`` for a name that already exists (answered as a success, since the
  page's goal — "that datapoint exists" — holds).

The type-definition shape follows ``furnace_sim/provision.py``, the module that
proved it against a real project: an ``OaDpTypeDefinition`` STRUCTURE root with
one STRING leaf per element. Imported lazily so the pure-logic modules stay
importable without a WinCC OA installation — the tests need exactly that.
"""

from __future__ import annotations

import logging
import platform
from typing import Any

from .protocol import (
    DP_PREFIX,
    DP_TYPE,
    HUB_DP,
    HUB_DP_TYPE,
    HUB_LEAF_INFO,
    HUB_LEAF_RESPONSE,
    HUB_LEAVES,
    LEAVES,
    HubRequest,
    hub_info_payload,
    hub_response_payload,
)

logger = logging.getLogger(__name__)


def _string_type(manager: Any, dp_type: str, leaves: tuple[str, ...]) -> None:
    """Create *dp_type* with one STRING leaf per name in *leaves*, if absent."""
    if dp_type in set(manager.dp_types(dp_type)):
        return

    # Imported only when something must actually be created, so a project where
    # the types already exist needs no WinCC OA import at all (and the tests can
    # exercise this module without one).
    from etm.wccoa.services.data import OaDpTypeDefinition, OaElementType

    definition = OaDpTypeDefinition(name=dp_type, element_type=OaElementType.STRUCTURE)
    for leaf in leaves:
        definition.add_leaf(leaf, OaElementType.STRING)
    manager.dp_type_create(definition)
    logger.info("created DP type %s", dp_type)


def ensure_types(manager: Any) -> None:
    """Create both DP types when missing — the per-signal one and the hub's."""
    _string_type(manager, DP_TYPE, LEAVES)
    _string_type(manager, HUB_DP_TYPE, HUB_LEAVES)


def ensure_hub(manager: Any, engines: dict[str, Any] | None = None) -> None:
    """Create the types and the hub datapoint, then publish the identity card.

    Called once on start. Writing ``info`` last is deliberate: it is what the page
    probes, so it must only appear when everything behind it is ready.
    """
    ensure_types(manager)
    if not manager.dp_exists(f"{HUB_DP}."):
        manager.dp_create(HUB_DP, HUB_DP_TYPE)
        logger.info("created hub datapoint %s", HUB_DP)
    runtime = f"python {platform.python_version()} on {platform.node()}"
    manager.dp_set_wait(f"{HUB_DP}.{HUB_LEAF_INFO}", hub_info_payload(runtime, engines))


def answer(manager: Any, request: HubRequest, ok: bool, dp: str, error: str = "") -> None:
    """Write the outcome of *request* on the hub's ``response`` leaf."""
    manager.dp_set_wait(
        f"{HUB_DP}.{HUB_LEAF_RESPONSE}",
        hub_response_payload(request.request_id, request.op, ok, dp, error),
    )
    if ok:
        logger.info("hub %s %s -> ok", request.op, dp or "?")
    else:
        logger.warning("hub %s %s -> refused: %s", request.op, dp or "?", error)


def handle(manager: Any, request: HubRequest) -> None:
    """Execute one hub request and answer it. Never raises.

    An engineering call that fails (a name the Event manager refuses, a datapoint
    deleted twice) becomes a readable ``error`` on ``response``, because the page
    is waiting for exactly one answer and a silent exception would leave it
    waiting until its own timeout.
    """
    dp = request.dp
    if dp == "":
        answer(manager, request, False, "", "no usable datapoint name")
        return
    if not dp.startswith(DP_PREFIX):
        answer(manager, request, False, dp, f"name outside {DP_PREFIX}*")
        return

    try:
        if request.is_create:
            _create(manager, request, dp)
        elif request.is_delete:
            _delete(manager, request, dp)
        else:  # pragma: no cover - parse_hub_request admits nothing else
            answer(manager, request, False, dp, f"unknown operation {request.op!r}")
    except Exception as error:  # noqa: BLE001 - the page must hear about it
        answer(manager, request, False, dp, str(error) or error.__class__.__name__)


def _create(manager: Any, request: HubRequest, dp: str) -> None:
    """Create the datapoint, and seed its ``config`` leaf with what was sent.

    An existing datapoint is a success: the page asked for it to exist, and it
    does. Seeding ``config`` here means the discovery loop finds a *usable* signal
    on its next pass even if the page never gets to write it (a browser closed
    between the request and the write).
    """
    ensure_types(manager)
    if manager.dp_exists(f"{dp}."):
        answer(manager, request, True, dp)
        return
    manager.dp_create(dp, DP_TYPE)
    if request.config_raw:
        manager.dp_set_wait(f"{dp}.config", request.config_raw)
    answer(manager, request, True, dp)


def _delete(manager: Any, request: HubRequest, dp: str) -> None:
    """Delete the datapoint. Already gone is a success, for the same reason."""
    if not manager.dp_exists(f"{dp}."):
        answer(manager, request, True, dp)
        return
    manager.dp_delete(dp)
    answer(manager, request, True, dp)
