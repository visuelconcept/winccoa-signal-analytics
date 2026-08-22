# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Chronos engine — anomalies as *forecast surprise*.

Amazon's Chronos is a pretrained time-series foundation model: give it a context
and it returns a predictive distribution for what comes next. That makes it a
detector of a different kind from the matrix profile, and the difference is the
reason the page offers the choice.

* The matrix profile asks **"has this shape occurred before?"** It flags what is
  *unlike the rest of this signal*, and it needs no training and no model file.
* Chronos asks **"was this what should have come next?"** It flags what is
  *unpredictable given what preceded it* — a step, a drift, a missed cycle — and
  it can call a shape anomalous the first time it matters, without waiting for a
  second occurrence to compare against.

The score written here is the residual in units of the model's own predictive
spread: ``|actual − median| / half-interquantile-range``. Dividing by the spread
is what makes one threshold work across a whole plant — a noisy signal earns a
wide interval and has to deviate further before it counts.

**Several signals are scored per dimension and aggregated by max.** Chronos is
a univariate model: each signal is forecast against its own past, its residuals
are already in units of its own predictive spread, and the joint score at an
instant is the WORST of them. Max rather than mean on purpose — a forecasting
residual is evidence of surprise in one signal, and averaging it with d-1 calm
ones would hide exactly the event being looked for. The price, stated plainly:
unlike the matrix-profile engines, this one cannot see an anomaly that lives
only in the *relation* between individually-predictable signals.

**Recurrences still come from the matrix profile.** Chronos forecasts, it does
not look for repeated shapes, so asking it for motifs would mean inventing a
meaning it does not have. This engine therefore runs the NumPy self-join for the
recurrence half and says so in ``notes``.

Cost, plainly: this engine needs ``chronos-forecasting`` and ``torch`` — a
multi-gigabyte install, and a model downloaded from Hugging Face on first use.
On CPU it is orders of magnitude slower than the matrix profile, which is why
the analysis is capped at :data:`MAX_BLOCKS` forecast blocks and the horizon is
widened to fit. It is unavailable until installed, and the page degrades to the
matrix profile rather than failing.

.. warning::
   The two call shapes below (``predict_quantiles`` on ``BaseChronosPipeline``,
   ``predict`` returning raw samples) are written from the published API of the
   ``chronos-forecasting`` package and have **not** been executed against an
   installed copy in this repository — nobody has installed it here yet. Both
   paths are attempted in turn and any failure is reported to the page rather
   than raised. Verify against the version you install before relying on it.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..matrix_profile import find_motifs, mstomp, robust_threshold
from .base import (
    Engine,
    EngineResult,
    ProgressFn,
    Samples,
    profile_payload,
    recurrence_records,
)

#: Upper bound on forecast blocks per analysis. A transformer costs milliseconds
#: to seconds per block on CPU; without a cap, a day of one-second samples would
#: mean thousands of them and the manager would look hung.
MAX_BLOCKS = 96

#: Contexts pushed through the model in one call.
BATCH_SIZE = 16

#: Quantiles requested: the median to compare against, the outer pair as spread.
QUANTILES = (0.1, 0.5, 0.9)

#: Loaded pipelines, keyed by model id — loading one costs seconds to minutes.
_PIPELINES: dict[str, Any] = {}


def _load_pipeline(model: str) -> Any:
    """Load (once) and return the Chronos pipeline for *model*."""
    cached = _PIPELINES.get(model)
    if cached is not None:
        return cached

    import torch
    from chronos import BaseChronosPipeline

    pipeline = BaseChronosPipeline.from_pretrained(
        model,
        device_map="cpu",
        torch_dtype=torch.float32,
    )
    _PIPELINES[model] = pipeline
    return pipeline


def _forecast(pipeline: Any, contexts: list[np.ndarray], horizon: int) -> tuple[np.ndarray, np.ndarray]:
    """Median and spread for each context, shape ``(batch, horizon)`` each.

    Tries the quantile API first and falls back to sampling, so the engine works
    with both the Bolt pipelines and the original sampling ones.
    """
    import torch

    tensors = [torch.tensor(context, dtype=torch.float32) for context in contexts]

    predict_quantiles = getattr(pipeline, "predict_quantiles", None)
    if callable(predict_quantiles):
        quantiles, _mean = predict_quantiles(
            context=tensors,
            prediction_length=horizon,
            quantile_levels=list(QUANTILES),
        )
        values = np.asarray(quantiles, dtype=np.float64)  # (batch, horizon, |quantiles|)
        low, median, high = values[..., 0], values[..., 1], values[..., 2]
        return median, (high - low) / 2.0

    samples = np.asarray(pipeline.predict(context=tensors, prediction_length=horizon), dtype=np.float64)
    # (batch, samples, horizon) -> quantiles over the sample axis.
    low, median, high = np.quantile(samples, QUANTILES, axis=1)
    return median, (high - low) / 2.0


def _events(
    scores: np.ndarray,
    covered: np.ndarray,
    threshold: float,
    gap: int,
    count: int,
) -> list[tuple[int, int, float]]:
    """Contiguous over-threshold stretches as ``(start, end, peak)``, worst first.

    A forecasting detector scores every sample, so one physical event arrives as
    a run of high scores rather than as a single index. Runs closer together than
    *gap* are merged — an anomaly the model half-recovers from mid-way is one
    event to an operator, not two.
    """
    flagged = covered & (scores > threshold)
    if not flagged.any():
        return []

    positions = np.flatnonzero(flagged)
    runs: list[list[int]] = [[int(positions[0]), int(positions[0])]]
    for position in positions[1:]:
        if int(position) - runs[-1][1] <= gap:
            runs[-1][1] = int(position)
        else:
            runs.append([int(position), int(position)])

    scored = [(start, end, float(scores[start : end + 1].max())) for start, end in runs]
    scored.sort(key=lambda event: event[2], reverse=True)
    return scored[:count]


class ChronosEngine(Engine):
    """Forecast-residual anomalies, matrix-profile recurrences."""

    id = "chronos"

    def available(self) -> tuple[bool, str]:
        try:
            import torch  # noqa: F401
        except ImportError as error:
            return False, f"torch is not installed ({error})"
        try:
            import chronos  # noqa: F401
        except ImportError as error:
            return False, f"chronos-forecasting is not installed ({error})"
        return True, ""

    def analyse(self, samples: Samples, config: Any, progress: ProgressFn) -> EngineResult:
        matrix = samples.values
        window = int(config.window)
        notes = ["recurrences from the matrix profile (chronos forecasts, it does not match shapes)"]
        if samples.joint:
            notes.append(
                f"per-dimension forecasts over {samples.dim_count} signals, aggregated by max"
            )

        size = samples.size
        context_length = min(int(config.chronos_context), max(32, size // 2))
        if size <= context_length + int(config.chronos_horizon):
            return EngineResult(
                engine=self.id,
                notes=notes + ["not-enough-samples-for-context"],
                reference=matrix,
            )

        # Widen the horizon until the whole series fits in MAX_BLOCKS forecasts.
        remaining = size - context_length
        horizon = max(int(config.chronos_horizon), math.ceil(remaining / MAX_BLOCKS))
        if horizon != int(config.chronos_horizon):
            notes.append(f"horizon widened to {horizon} samples to stay within {MAX_BLOCKS} forecasts")

        progress(20, f"loading {config.chronos_model}")
        try:
            pipeline = _load_pipeline(str(config.chronos_model))
        except Exception as error:
            return EngineResult(
                engine=self.id,
                notes=notes + [f"model could not be loaded: {error}"],
                reference=matrix,
            )

        starts = list(range(context_length, size, horizon))
        per_dim_scores = np.zeros((samples.dim_count, size))
        covered = np.zeros(size, dtype=bool)
        total_batches = samples.dim_count * max(1, len(starts))
        done_batches = 0

        for dim in range(samples.dim_count):
            values = matrix[dim]
            # A spread floor tied to each signal's own scale: without it, a
            # stretch the model finds perfectly predictable divides by ~0 and
            # every sample after it scores as an anomaly.
            floor = max(1e-9, float(np.std(values)) * 0.02)
            for batch_index in range(0, len(starts), BATCH_SIZE):
                batch = starts[batch_index : batch_index + BATCH_SIZE]
                contexts = [values[max(0, start - context_length) : start] for start in batch]
                try:
                    median, spread = _forecast(pipeline, contexts, horizon)
                except Exception as error:
                    return EngineResult(
                        engine=self.id,
                        notes=notes + [f"forecast failed: {error}"],
                        reference=matrix,
                    )

                for offset, start in enumerate(batch):
                    end = min(start + horizon, size)
                    actual = values[start:end]
                    predicted = median[offset][: end - start]
                    deviation = np.maximum(spread[offset][: end - start], floor)
                    per_dim_scores[dim, start:end] = np.abs(actual - predicted) / deviation
                    covered[start:end] = True

                done_batches += len(batch)
                progress(20 + int(60 * done_batches / total_batches), "forecasting")

        scores = per_dim_scores.max(axis=0)
        threshold = robust_threshold(scores[covered], float(config.sensitivity))
        events = _events(scores, covered, threshold, max(1, window // 2), int(config.max_anomalies))
        anomalies = []
        for rank, (start, end, peak) in enumerate(events, start=1):
            record = {
                "rank": rank,
                "start": int(samples.times[start]),
                "end": int(samples.times[end]),
                "index": int(start),
                "score": round(peak, 4),
                "severity": round(peak / threshold, 3) if threshold > 0 else None,
            }
            if samples.joint:
                # Each signal's peak residual over the event, as shares — the
                # forecasting analogue of the matrix engines' contributions.
                peaks = per_dim_scores[:, start : end + 1].max(axis=1)
                total = float(peaks.sum())
                if total > 0:
                    record["contributions"] = {
                        dpe: round(float(value) / total, 3)
                        for dpe, value in zip(samples.dpes, peaks)
                    }
            anomalies.append(record)
        if not anomalies:
            notes.append("no-anomaly-above-threshold")

        progress(85, "recurrences")
        profile, index = mstomp(matrix, window)
        series = matrix if samples.joint else matrix[0]
        # The recurrence cut-off comes from the profile's own spread: the anomaly
        # threshold above is in residual units and says nothing about distances.
        motifs = find_motifs(
            series,
            profile,
            index,
            window,
            int(config.max_recurrences),
            float(config.recurrence_radius),
            max_distance=robust_threshold(profile, float(config.sensitivity)),
        )
        if not motifs:
            notes.append("no-recurring-shape")

        return EngineResult(
            engine=self.id,
            anomalies=anomalies,
            recurrences=recurrence_records(samples, motifs, window),
            # The band under the chart shows the residual score, since that is
            # what this engine's threshold is drawn against.
            profile=profile_payload(samples, np.where(covered, scores, 0.0), window),
            threshold=round(float(threshold), 4),
            notes=notes,
            reference=matrix,
        )
