"""Which player hit each shot, positionally.

There is no appearance matching here and no attempt at identity. Swings are
clustered by *where on the court* they happened, and each cluster gets a slot
name: left/right across the frame, or near/far up it.

That is all a pipeline can honestly know. The moment two players swap ends,
"left" stops meaning the same person -- which is exactly why the schema keeps
`player_slot` (what this module produces) separate from `player_name` (what a
human supplies in user-edit.json).

The split is placed at the widest gap in the sorted positions rather than at
the midpoint of the frame, because players do not stand symmetrically and a
camera is rarely centred. Searching only the middle half avoids splitting off
a single outlier at either end.
"""

SIDE, DEPTH = "side", "depth"


def widest_gap(values):
    """Boundary at the largest gap between consecutive sorted values.

    Every interior gap is considered. An earlier version searched only the
    middle half, meaning to skip the gap between the bulk of the data and a
    stray -- but that also skipped the real boundary whenever the two players
    took unequal numbers of swings (15 and 4 put the jump outside the
    window, so it was never even examined). Strays are rejected downstream
    instead, by the gap-ratio and minimum-zone-size tests in assign().
    """
    ordered = sorted(values)
    if len(ordered) < 2:
        return None
    best_gap, boundary = -1.0, None
    for i in range(1, len(ordered)):
        gap = ordered[i] - ordered[i - 1]
        if gap > best_gap:
            best_gap, boundary = gap, (ordered[i] + ordered[i - 1]) / 2.0
    return boundary


def gap_stats(values):
    """(boundary, gap_at_boundary, median_gap) for the candidate split.

    The median gap is what tells a real split from an evenly spread single
    cluster: one player's swings are spaced roughly uniformly, so no gap
    stands out, whereas two players leave one gap far larger than the rest.
    """
    ordered = sorted(values)
    if len(ordered) < 2:
        return None, 0.0, 0.0
    boundary = widest_gap(ordered)
    if boundary is None:
        return None, 0.0, 0.0
    gaps = [ordered[i] - ordered[i - 1] for i in range(1, len(ordered))]
    at_boundary = 0.0
    for i in range(1, len(ordered)):
        if ordered[i - 1] <= boundary <= ordered[i]:
            at_boundary = ordered[i] - ordered[i - 1]
            break
    ordered_gaps = sorted(gaps)
    mid = len(ordered_gaps) // 2
    median_gap = (ordered_gaps[mid] if len(ordered_gaps) % 2
                  else (ordered_gaps[mid - 1] + ordered_gaps[mid]) / 2.0)
    return boundary, at_boundary, median_gap


# A real two-player split leaves one gap several times the typical spacing.
GAP_RATIO = 4.0

# Fewest swings a zone needs before it counts as a player rather than noise.
MIN_ZONE_SWINGS = 3


def _position(measured, mode):
    """The coordinate a swing is clustered on."""
    if mode == DEPTH:
        # Apparent body size stands in for distance: a nearer player is
        # bigger. Crude, but it needs no calibration.
        return measured.torso_height
    return measured.center_x


def assign(swings, mode=SIDE, count=0):
    """Assign a player_slot to each swing.

    swings: list of Measured (only accepted ones should be passed).
    count:  0 to decide automatically, or 1/2 to force.
    Returns (slots, info) where slots is a list parallel to `swings` and info
    is the `players` block of a SessionDoc.
    """
    positions = [_position(m, mode) for m in swings]
    usable = [p for p in positions if p is not None]

    low, high = ((("left", "right")) if mode == SIDE else ("far", "near"))

    if not usable:
        return [None] * len(swings), {"mode": mode, "count": 0, "zones": []}

    boundary = None
    if count != 1 and len(usable) >= 4:
        boundary, gap, median_gap = gap_stats(usable)
        if boundary is not None:
            left = [p for p in usable if p < boundary]
            right = [p for p in usable if p >= boundary]
            # Three ways a candidate split is not really a split:
            #   - the positions barely spread at all
            #   - the gap is no bigger than the typical spacing, i.e. one
            #     evenly distributed cluster rather than two groups
            #   - one side holds almost nothing, i.e. a stray detection
            too_flat = (max(usable) - min(usable)) <= 0
            not_separated = gap < max(median_gap * GAP_RATIO, 1e-9)
            # A genuine second player takes several swings; one or two
            # detections across the court is a stray. The gap test above
            # already rejects an evenly spread single cluster, so this only
            # needs to catch outliers -- a flat minimum, not a proportion,
            # so that a player who took 4 of 19 swings still counts.
            lopsided = min(len(left), len(right)) < MIN_ZONE_SWINGS
            if too_flat or not_separated or (lopsided and count == 0):
                boundary = None

    if boundary is None or count == 1:
        slots = [(low if p is not None else None) for p in positions]
        return slots, {
            "mode": mode, "count": 1,
            "zones": [{"slot": low, "range": [_r(min(usable)), _r(max(usable))],
                       "swings": len(usable)}],
        }

    slots = []
    for p in positions:
        if p is None:
            slots.append(None)
        else:
            slots.append(low if p < boundary else high)

    low_vals = [p for p in usable if p < boundary]
    high_vals = [p for p in usable if p >= boundary]
    return slots, {
        "mode": mode, "count": 2,
        "boundary": _r(boundary),
        "zones": [
            {"slot": low, "range": [_r(min(low_vals)), _r(max(low_vals))],
             "swings": len(low_vals)},
            {"slot": high, "range": [_r(min(high_vals)), _r(max(high_vals))],
             "swings": len(high_vals)},
        ],
    }


def _r(value):
    return round(float(value), 4)
