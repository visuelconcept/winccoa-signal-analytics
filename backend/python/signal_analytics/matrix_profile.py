# SPDX-FileCopyrightText: 2026 VISUEL CONCEPT
# SPDX-License-Identifier: AGPL-3.0-only

"""Matrix profile in plain NumPy — the shared arithmetic of every engine.

The matrix profile of a series is, for each subsequence of length *m*, the
z-normalised Euclidean distance to its nearest neighbour elsewhere in the same
series. Two readings of that one array give the page both of the things it asks
for:

* a **large** value means "this shape happens nowhere else" → a *discord*, i.e.
  an anomaly;
* a **small** value means "this shape happens again" → a *motif*, i.e. a
  recurrence.

Why implement it here when ``stumpy`` does exactly this. Three reasons, in order
of weight: the page must produce findings on a plain WinCC OA installation where
nobody has run ``pip install`` yet; ``stumpy`` pulls in ``numba``, whose accepted
NumPy range trails the current release, so it is a dependency that *can* refuse
to import on an up-to-date machine; and having a second implementation of the
same quantity makes the ``stumpy`` engine verifiable rather than merely trusted
(see ``test_matrix_profile.py``, which asserts the two agree).

The algorithm is STOMP (Zhu et al., 2016): the first distance profile comes from
an FFT sliding dot product, each later row updates the previous one in O(l), and
because the distance matrix is symmetric a single pass over the rows fills the
whole profile. That is O(n²) time, O(n) memory — which is why :mod:`.analysis`
downsamples to ``max_points`` before calling in.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: Distance between two z-normalised subsequences that share no shape at all.
#: ``sqrt(2m)`` is the maximum the metric can reach (correlation of -1).
_MAX_CORRELATION = 1.0


def sliding_stats(series: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean and standard deviation of every length-*window* subsequence.

    Computed from cumulative sums, so the cost is O(n) rather than O(n·m). The
    series is centred first: a cumulative sum over values that share a large
    offset (an absolute pressure, an epoch-like counter) loses precision in
    exactly the digits the variance is made of.
    """
    centred = series - series.mean()
    ones = np.cumsum(np.insert(centred, 0, 0.0))
    squares = np.cumsum(np.insert(centred * centred, 0, 0.0))
    total = ones[window:] - ones[:-window]
    total_squares = squares[window:] - squares[:-window]
    mu = total / window
    variance = total_squares / window - mu * mu
    # Cancellation can push a variance a hair below zero on a constant stretch.
    np.maximum(variance, 0.0, out=variance)
    return mu + series.mean(), np.sqrt(variance)


def sliding_dot(query: np.ndarray, series: np.ndarray) -> np.ndarray:
    """Dot product of *query* with every subsequence of *series*, via FFT."""
    n = series.size
    m = query.size
    size = 1 << int(n + m - 1).bit_length()
    padded_query = np.zeros(size)
    padded_query[:m] = query[::-1]
    padded_series = np.zeros(size)
    padded_series[:n] = series
    product = np.fft.irfft(np.fft.rfft(padded_series) * np.fft.rfft(padded_query), size)
    return product[m - 1 : n]


def _distances(
    dot: np.ndarray,
    mu: np.ndarray,
    sigma: np.ndarray,
    mu_query: float,
    sigma_query: float,
    window: int,
) -> np.ndarray:
    """Z-normalised Euclidean distances from one subsequence to all others.

    Derived from the Pearson correlation rather than from the definition, which
    is what makes the O(1)-per-cell update of STOMP possible at all. Flat
    subsequences have no correlation to speak of (σ = 0, the formula divides by
    zero): two flat stretches are declared identical, a flat one against a
    varying one maximally different. Without that case a signal that idles —
    every real process signal — would fill the profile with NaN.
    """
    flat = sigma <= 0.0
    query_flat = sigma_query <= 0.0
    with np.errstate(divide="ignore", invalid="ignore"):
        correlation = (dot - window * mu * mu_query) / (window * sigma * sigma_query)
    np.clip(correlation, -_MAX_CORRELATION, _MAX_CORRELATION, out=correlation)
    if query_flat:
        correlation[:] = np.where(flat, _MAX_CORRELATION, -_MAX_CORRELATION)
    else:
        correlation[flat] = -_MAX_CORRELATION
    return np.sqrt(2.0 * window * (1.0 - correlation))


def exclusion_zone(window: int) -> int:
    """Neighbours this close are the *same* shape shifted, not a second one."""
    return max(1, int(np.ceil(window / 4.0)))


def stomp(series: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """Self-join matrix profile: distance to, and index of, each nearest neighbour.

    Returns ``(profile, index)``, both of length ``n - window + 1``. An entry is
    ``inf`` / ``-1`` only if the series is too short to hold two non-overlapping
    subsequences at all.
    """
    series = np.ascontiguousarray(series, dtype=np.float64)
    n = series.size
    length = n - window + 1
    if length < 2:
        return np.full(max(length, 0), np.inf), np.full(max(length, 0), -1, dtype=np.int64)

    mu, sigma = sliding_stats(series, window)
    first_row_dot = sliding_dot(series[:window], series)
    dot = first_row_dot.copy()

    profile = np.full(length, np.inf)
    index = np.full(length, -1, dtype=np.int64)
    excluded = exclusion_zone(window)
    # Reused across rows so the loop allocates nothing per iteration.
    head = series[: length - 1]
    tail = series[window : window + length - 1]

    for row in range(length):
        if row > 0:
            # STOMP's O(1) update: slide both ends of every dot product by one.
            dot[1:] = dot[:-1] - head * series[row - 1] + tail * series[row + window - 1]
            dot[0] = first_row_dot[row]

        distances = _distances(dot, mu, sigma, mu[row], sigma[row], window)
        low = max(0, row - excluded)
        high = min(length, row + excluded + 1)
        distances[low:high] = np.inf

        nearest = int(np.argmin(distances))
        if distances[nearest] < profile[row]:
            profile[row] = distances[nearest]
            index[row] = nearest
        # The matrix is symmetric, so this row also improves the columns it
        # crosses — which is what lets one pass produce the whole profile.
        better = distances < profile
        profile[better] = distances[better]
        index[better] = row

    return profile, index


def mass(query: np.ndarray, series: np.ndarray, window: int) -> np.ndarray:
    """Distances from *query* to every subsequence of *series* (an AB-join row).

    The real-time path: one new subsequence against the whole historical
    reference. Its minimum is the same quantity the historical profile holds, so
    a live score is comparable to the threshold learnt from that profile.
    """
    series = np.ascontiguousarray(series, dtype=np.float64)
    query = np.ascontiguousarray(query, dtype=np.float64)
    mu, sigma = sliding_stats(series, window)
    dot = sliding_dot(query, series)
    return _distances(dot, mu, sigma, float(query.mean()), float(query.std()), window)


def robust_threshold(profile: np.ndarray, sensitivity: float) -> float:
    """Anomaly cut-off: ``median + sensitivity × MAD`` over the finite profile.

    Median and MAD rather than mean and σ on purpose — the anomalies are *in*
    the sample being summarised, and they are exactly the values that would drag
    a mean-based threshold up above themselves.
    """
    finite = profile[np.isfinite(profile)]
    if finite.size == 0:
        return float("inf")
    median = float(np.median(finite))
    mad = float(np.median(np.abs(finite - median)))
    # 1.4826 rescales a MAD to a standard deviation for normally distributed
    # data, so `sensitivity` reads as "sigmas" the way an operator expects.
    scaled = mad * 1.4826
    if scaled <= 0.0:
        # A profile with no spread at all: only a strictly larger value can
        # stand out, so cut just above the median.
        return median + max(1e-9, abs(median) * 1e-6)
    return median + sensitivity * scaled


def find_discords(
    profile: np.ndarray,
    window: int,
    count: int,
    threshold: float,
) -> list[tuple[int, float]]:
    """The *count* most isolated subsequences above *threshold*, best first.

    Each pick blanks a whole window on either side. The narrow ``m/4`` zone used
    while *building* the profile is the wrong one here: every subsequence that
    merely touches an anomaly scores high, so an event of length *m* is detected
    by a band of them, and picking the top five would return five views of one
    excursion. Two windows apart is the point at which two detections can no
    longer be explained by the same underlying event.
    """
    working = profile.copy()
    working[~np.isfinite(working)] = -np.inf
    excluded = 2 * window
    found: list[tuple[int, float]] = []
    for _ in range(count):
        best = int(np.argmax(working))
        score = float(working[best])
        if not np.isfinite(score) or score < threshold:
            break
        found.append((best, score))
        working[max(0, best - excluded) : best + excluded + 1] = -np.inf
    return found


def neighbour_distances(series: np.ndarray, seed: int, window: int) -> np.ndarray:
    """Distances from the subsequence at *seed* to every other one.

    The one place the motif search touches the values, so it is also the one
    place that has to know whether the series is univariate ``(n,)`` or a joint
    ``(d, n)`` matrix — everything around it works on the aggregated profile and
    does not care.
    """
    if series.ndim == 1:
        return mass(series[seed : seed + window], series, window)
    return mass_multi(series[:, seed : seed + window], series, window)


def find_motifs(
    series: np.ndarray,
    profile: np.ndarray,
    index: np.ndarray,
    window: int,
    count: int,
    radius: float,
    max_distance: float = float("inf"),
) -> list[dict[str, Any]]:
    """The *count* most repeated shapes, each with all of its occurrences.

    The smallest profile value names the best-matching *pair*; every other
    subsequence within ``radius × that distance`` of it belongs to the same
    motif, which turns a pair into the group an operator actually wants to see
    ("this shape happened four times"). Members are then excluded so the next
    motif is a different shape and not a neighbour of the first.

    Both exclusions here are a full window, not the ``m/4`` used to *build* the
    profile: two occurrences that overlap are one occurrence counted twice, and a
    second motif made of the first one's members shifted by a few samples is the
    same finding reported again. The search also stops at *max_distance*, the
    point where a "best match" has stopped being a match at all.
    """
    working = profile.copy()
    working[~np.isfinite(working)] = np.inf
    excluded = window
    motifs: list[dict[str, Any]] = []

    for _ in range(count):
        seed = int(np.argmin(working))
        distance = float(working[seed])
        if not np.isfinite(distance):
            break
        # A "recurrence" whose own best match sits as far away as an anomaly is
        # not one: past this point the loop only reports the least-bad leftovers.
        if distance >= max_distance:
            break

        neighbours = neighbour_distances(series, seed, window)
        neighbours[~np.isfinite(neighbours)] = np.inf
        # Never rejects the seed itself, even when the pair distance is 0.
        limit = max(distance * radius, distance + 1e-9)
        candidates = np.argsort(neighbours)
        members: list[int] = []
        for candidate in candidates:
            position = int(candidate)
            if neighbours[position] > limit:
                break
            if any(abs(position - kept) < excluded for kept in members):
                continue
            members.append(position)

        partner = int(index[seed])
        if partner >= 0 and all(abs(partner - kept) >= excluded for kept in members):
            members.append(partner)
        members.sort()

        for member in members:
            working[max(0, member - excluded) : member + excluded + 1] = np.inf

        if len(members) >= 2:
            motifs.append({"seed": seed, "distance": distance, "members": members})

    return motifs


# ---------------------------------------------------------------------------
# Multivariate (joint) profile — mSTAMP with k = d
# ---------------------------------------------------------------------------
#
# mSTAMP (Yeh et al., 2017) generalises the matrix profile to d aligned series:
# compute the z-normalised distance profile PER DIMENSION, then aggregate across
# dimensions before taking each subsequence's nearest neighbour. With k = d the
# aggregate is the plain mean — one number per pair of time windows meaning "how
# unlike are these two moments, all signals considered".
#
# Two consequences worth stating because they shape what the page shows:
#
# * an anomaly confined to ONE of d signals is diluted by the mean (its distance
#   is averaged with d-1 unremarkable ones). The averaging also shrinks the
#   profile's noise, so in practice a clear single-signal event still stands out
#   — but a *marginal* one is easier to catch by configuring that signal alone;
# * an anomaly that lives in the RELATION between signals — the correlation
#   breaks while each signal stays individually plausible — is exactly what the
#   per-dimension profiles cannot see and this one can. That case is the reason
#   the joint analysis exists.


def mstomp(matrix: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """Joint self-join profile over ``(d, n)`` aligned series.

    Same STOMP row recurrence as :func:`stomp`, run on all dimensions at once;
    each row's per-dimension distances are averaged before the min. Returns
    ``(profile, index)`` of length ``n - window + 1``, directly comparable in
    meaning (not in scale) to the univariate profile.
    """
    matrix = np.ascontiguousarray(matrix, dtype=np.float64)
    if matrix.ndim == 1:
        return stomp(matrix, window)
    dims, n = matrix.shape
    length = n - window + 1
    if length < 2:
        return np.full(max(length, 0), np.inf), np.full(max(length, 0), -1, dtype=np.int64)

    mu = np.empty((dims, length))
    sigma = np.empty((dims, length))
    first_row_dot = np.empty((dims, length))
    for dim in range(dims):
        mu[dim], sigma[dim] = sliding_stats(matrix[dim], window)
        first_row_dot[dim] = sliding_dot(matrix[dim, :window], matrix[dim])
    dot = first_row_dot.copy()

    profile = np.full(length, np.inf)
    index = np.full(length, -1, dtype=np.int64)
    excluded = exclusion_zone(window)
    heads = matrix[:, : length - 1]
    tails = matrix[:, window : window + length - 1]
    row_distances = np.empty((dims, length))

    for row in range(length):
        if row > 0:
            dot[:, 1:] = (
                dot[:, :-1]
                - heads * matrix[:, row - 1 : row]
                + tails * matrix[:, row + window - 1 : row + window]
            )
            dot[:, 0] = first_row_dot[:, row]

        for dim in range(dims):
            row_distances[dim] = _distances(
                dot[dim], mu[dim], sigma[dim], mu[dim, row], sigma[dim, row], window
            )
        distances = row_distances.mean(axis=0)
        low = max(0, row - excluded)
        high = min(length, row + excluded + 1)
        distances[low:high] = np.inf

        nearest = int(np.argmin(distances))
        if distances[nearest] < profile[row]:
            profile[row] = distances[nearest]
            index[row] = nearest
        better = distances < profile
        profile[better] = distances[better]
        index[better] = row

    return profile, index


def mass_multi(query: np.ndarray, matrix: np.ndarray, window: int) -> np.ndarray:
    """Joint AB-join row: mean per-dimension distance from one ``(d, window)``
    query to every subsequence of ``(d, n)`` — the multivariate :func:`mass`,
    and therefore the live score that matches an :func:`mstomp` threshold."""
    if matrix.ndim == 1:
        return mass(query if query.ndim == 1 else query[0], matrix, window)
    stacked = [mass(query[dim], matrix[dim], window) for dim in range(matrix.shape[0])]
    return np.mean(np.stack(stacked), axis=0)


def dimension_contributions(matrix: np.ndarray, start: int, window: int) -> list[float]:
    """How unusual each signal was, alone, over the window at *start*.

    Per dimension: the distance from that window to its own nearest neighbour
    anywhere else in the same dimension — the univariate profile value at
    *start*, computed post-hoc so it works identically whichever engine produced
    the joint profile. Returned as fractions summing to 1, which is the form
    "temperature 62 %" wants.
    """
    if matrix.ndim == 1:
        return [1.0]
    excluded = exclusion_zone(window)
    raw: list[float] = []
    for dim in range(matrix.shape[0]):
        distances = mass(matrix[dim, start : start + window], matrix[dim], window)
        low = max(0, start - excluded)
        high = min(distances.size, start + excluded + 1)
        distances[low:high] = np.inf
        finite = distances[np.isfinite(distances)]
        raw.append(float(finite.min()) if finite.size > 0 else 0.0)
    total = sum(raw)
    if total <= 0.0:
        return [1.0 / len(raw)] * len(raw)
    return [value / total for value in raw]
