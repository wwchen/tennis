"""Was this candidate actually a swing? And which arm swung?

The candidate reaching here is a wrist-speed peak that found a strike near it
(`scan.corroborate`), or, with `detector="audio"`, a bare onset. Either way
this stage sees only the dense landmark track around it.

Two jobs, both derived from that single track:

  * accept or reject the candidate, with a reason from a fixed enum so the
    rejection histogram makes tuning measurable rather than anecdotal
  * pick the hitting wrist, and measure the swing around it

The wrist choice is the one piece of real diagnosis carried over from the
previous code. That version chose the wrist *furthest from the body midline*,
reasoning that the hitting arm is extended. It is not: the free arm is
usually flung wider for balance. The old README measured the damage at 22%
stroke agreement (10 of 46 hand labels) and found contact_x clustering
bimodally at -1.77 and +0.86 -- two clusters because it was measuring two
different arms.

The fix: the hitting wrist is the one that *moves fastest*. A racket arm
accelerates through contact; a balance arm does not. Speed also degrades
gracefully -- a wrong pick on a slow swing matters less than on a fast one.

All lengths are in torso heights and all speeds in torso heights per second,
so a player at the back of the court is comparable to one near the camera.
"""

from . import pose as pose_mod

# Reject reasons, mirroring schema.REJECT_REASONS.
NO_POSE = "no_pose"
TORSO_TOO_SMALL = "torso_too_small"
NO_WRIST_TRACK = "no_wrist_track"
WRIST_TOO_SLOW = "wrist_too_slow"
# Dead as a code path: nothing returns this any more. It stays because output
# trees already on disk record it in their reject histograms, so
# `schema.REJECT_REASONS` must keep accepting it and `verify()` must keep
# knowing where it ranks. Do not remove either.
ONSET_OFF_SWING = "onset_off_swing"
# The wrist's fastest moment is far from the onset AND slow: nobody was
# swinging when the sound happened. See `Settings.reanchor_min_speed`.
PEAK_OFF_ONSET = "reanchor_too_slow"

MIN_DETECTED_FRAMES = 4

# How far from the onset the wrist's peak may sit, as a fraction of the pose
# window. Must be < 1.0 or the test is vacuous -- the track is only that wide
# to begin with. See measure_slot().
ONSET_WINDOW_FRACTION = 0.5
# A wrist that jumps implausibly far between frames is a detector glitch, not
# a limb: cap it rather than letting one bad frame dominate peak speed.
#
# 40.0 was far too low and did real damage. Re-measured over 278 cached pose
# tracks with the cap lifted, peak wrist speed runs p50 38.2, p90 70.3, p99
# 81.8, max 123 -- so the old cap sat at the MEDIAN and flattened 63% of the
# shipped corpus onto one value. Two consequences, both measured:
#
#   * `wrist_peak_speed` stopped being a usable dimension. Anything comparing
#     two swings by it was comparing 40.0 with 40.0.
#   * Worse, `choose_hitting_side` picks the faster wrist with a strict `>`
#     and tries "left" first, so every tie became "left". With the cap, 33%
#     of tracks tie; without it, 0% do. Across the shipped corpus that reads
#     as 90.9% left-handed among capped swings against 51.6% among uncapped
#     ones -- roughly 620 swings with the wrong arm recorded, and with
#     `contact_offset`/`contact_height` therefore measured on the free arm.
#     That is the exact fault this module's docstring describes fixing once
#     already; the cap reintroduced it through a different door.
#
# 150.0 is chosen to stop the cap DECIDING anything, not because nothing
# reaches it. Measured with the cap fully lifted across all 25 cached sessions
# (2779 tracks), the tail is long: p50 33, p90 87, p99 279, max 949. At 150 the
# cap still binds on 3.56% of tracks -- but on zero LR ties, which is the
# failure it caused before. `BODY_JUMP` filtering removes the teleports, and
# what is left above ~50 is single-frame landmark jitter rather than a limb.
#
# Which means the honest reading of this dimension is narrower than its range
# suggests. A torso is roughly half a metre, so 150 torso-heights/s implies a
# 75 m/s wrist; an elite serve's RACKET HEAD peaks near 50 m/s and the wrist
# far below that. Anything above roughly 50 here is measurement noise that
# happened to survive the jump filter. Treat `wrist_peak_speed` as ordinal
# within a swing (which wrist moved faster) and as a coarse gate against
# `min_wrist_speed`; do not read the number as a physical speed, and do not
# build a threshold in the tail without re-measuring it first.
SPEED_CAP = 150.0


class Measured:
    """Per-slot swing measurements, or a reason the slot is unusable."""

    __slots__ = ("slot", "reason", "hitting_side", "wrist_peak_speed",
                 "torso_height", "contact_offset", "contact_height",
                 "peak_ms", "center_x", "boxes",
                 # The instant this swing is anchored on, and whether pose had
                 # to move it off the audio onset to get there.
                 "contact_ms", "reanchored")

    def __init__(self, slot, reason=None, hitting_side=None,
                 wrist_peak_speed=None, torso_height=None,
                 contact_offset=None, contact_height=None, peak_ms=None,
                 center_x=None, boxes=None, contact_ms=None,
                 reanchored=False):
        self.slot = slot
        self.reason = reason
        self.hitting_side = hitting_side
        self.wrist_peak_speed = wrist_peak_speed
        self.torso_height = torso_height
        self.contact_offset = contact_offset
        self.contact_height = contact_height
        self.peak_ms = peak_ms
        self.contact_ms = contact_ms
        self.reanchored = reanchored
        self.center_x = center_x
        self.boxes = boxes or []

    @property
    def ok(self):
        return self.reason is None

    def to_metadata(self):
        """The `measurements` block of a SwingDoc, or None if unusable."""
        if not self.ok:
            return None
        return {
            "space": "crop_normalized",
            "origin": "top_left",
            "units": {"length": "torso_heights",
                      "speed": "torso_heights_per_s"},
            "hitting_side": self.hitting_side,
            "per_frame": "pose.json",
            "wrist_peak_speed": _round(self.wrist_peak_speed),
            "torso_height": _round(self.torso_height),
            "contact_offset": _round(self.contact_offset),
            "contact_height": _round(self.contact_height),
            # Where on court the player was, at contact. Measured all along and
            # thrown away at this line: `dedupe_swings` decides whether two
            # detections are one player from exactly this number, so without it
            # on disk that decision could not be audited after the fact, and
            # nothing downstream could tell a cross-court rally from one player
            # hitting twice. Frame-normalized like every other x here, NOT in
            # torso heights -- it is a position, and the torso scale that makes
            # two positions comparable belongs with the pair, not the point.
            "center_x": _round(self.center_x),
        }


def _round(value, places=4):
    return None if value is None else round(float(value), places)


def _median(values):
    ordered = sorted(values)
    n = len(ordered)
    if not n:
        return 0.0
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def wrist_speeds(series, wrist_index, torso, aspect=1.0):
    """[(source_ms, speed)] for one wrist, in torso heights per second.

    Speed is measured over the interval *centred* on each sample, so a peak
    lands on the frame where the wrist is fastest rather than half an
    interval late.

    Interior samples only. A one-sided difference at the ends spans half the
    baseline, so identical jitter reads ~2x hotter there (2.27 against 1.14)
    and argmax landed on an endpoint in 50% of trials against 8% by chance.

    `aspect` is frame width/height. x and y are each normalized to their own
    axis, so mixing them in one distance measures horizontal motion in
    width-fractions and divides it by a torso height measured in
    height-fractions. A tennis swing is mostly horizontal, so on 16:9 footage
    that understated nearly every speed by 1.78x.

    Triples spanning an identity change are skipped rather than measured: a
    "wrist" that teleports to another player produces the fastest reading in
    the session. Measured over 396 shipped swings, 43% reported a peak that
    sat on one -- and since `verify` picks the slot with the fastest wrist,
    those flips were also choosing which player to measure.
    """
    if len(series) < 3 or torso <= 0:
        return []
    out = []
    for i in range(1, len(series) - 1):
        j0 = i - 1
        j1 = i + 1
        t0, a = series[j0]
        t1, b = series[j1]
        dt = (t1 - t0) / 1000.0
        if dt <= 0:
            continue
        centres = [a.center_x(), series[i][1].center_x(), b.center_x()]
        if max(centres) - min(centres) > pose_mod.BODY_JUMP:
            continue
        ax, ay = a.xy(wrist_index)
        bx, by = b.xy(wrist_index)
        dx = (bx - ax) * aspect
        dy = by - ay
        dist = (dx * dx + dy * dy) ** 0.5 / torso
        out.append((series[i][0], min(dist / dt, SPEED_CAP)))
    return out


def choose_hitting_side(series, torso, aspect=1.0):
    """Return ("left"|"right", peak_speed, peak_ms) by peak wrist speed.

    Not by reach. See the module docstring: reach selects the free arm.
    """
    best = (None, -1.0, None)
    tied = False
    for side, index in (("left", pose_mod.L_WRIST),
                        ("right", pose_mod.R_WRIST)):
        speeds = wrist_speeds(series, index, torso, aspect)
        if not speeds:
            continue
        peak_ms, peak = max(speeds, key=lambda row: row[1])
        if peak > best[1]:
            best = (side, peak, peak_ms)
            tied = False
        elif peak == best[1] and peak > 0:
            # Exactly equal NON-ZERO peaks mean this measurement cannot tell
            # the arms apart. Silently keeping whichever was tried first is
            # what turned a saturated speed into a 91%-left corpus; with
            # SPEED_CAP raised this is unreachable on real footage, and if it
            # ever fires again it should be visible rather than decided by
            # loop order.
            #
            # Zero is excluded because it is not that case: a player standing
            # still ties at 0.0 on both wrists, and "nobody swung" is already
            # said better, and earlier, by `wrist_too_slow`. Nulling the side
            # there would relabel every standing player as `no_wrist_track`.
            tied = True
    if tied:
        return (None, best[1], best[2])
    return best


def frame_aspect(track):
    """Frame width/height, or 1.0 when the decoder never reported a size."""
    size = getattr(track, "frame_size", None)
    if not size or not size[1]:
        return 1.0
    return float(size[0]) / float(size[1])


def measure_slot(track, slot, settings):
    """Measure one positional slot of a track."""
    series = track.series(slot)
    if len(series) < MIN_DETECTED_FRAMES:
        return Measured(slot, reason=NO_POSE)

    torsos = [lm.torso_height() for _, lm in series]
    torso = _median(torsos)
    if torso < settings.min_torso:
        return Measured(slot, reason=TORSO_TOO_SMALL, torso_height=torso)

    side, peak_speed, peak_ms = choose_hitting_side(series, torso,
                                                    frame_aspect(track))
    if side is None:
        return Measured(slot, reason=NO_WRIST_TRACK, torso_height=torso)
    if peak_speed < settings.min_wrist_speed:
        return Measured(slot, reason=WRIST_TOO_SLOW, torso_height=torso,
                        wrist_peak_speed=peak_speed, hitting_side=side,
                        peak_ms=peak_ms)

    # The onset should coincide with the swing, not sit outside it. A ball
    # bouncing near a stationary player would otherwise pass.
    #
    # The tolerance is a *fraction* of the pose window, and has to be: the
    # track is decoded as contact +/- pose_window_s, so comparing against
    # the full window made this unreachable by construction. It never fired
    # on real footage and the histogram read onset_off_swing: 0 forever.
    # Half the window means the wrist's fastest moment must land in the
    # middle of the decoded span, which is what "the onset is on the swing"
    # actually means.
    # ...and when it does sit outside, the swing is KEPT, at its onset.
    #
    # Rejecting it threw away real shots (25 of 29 candidates on IMG_0304).
    # Moving contact to the peak was worse: recall 100% on the onset against
    # 58% on the moved value, 0.2-0.35s off on every shot it touched. The
    # distance is evidence about the candidate, not a correction to apply.
    window_ms = settings.pose_window_s * 1000.0 * ONSET_WINDOW_FRACTION
    peak_off_swing = (peak_ms is not None
                      and abs(peak_ms - track.contact_ms) > window_ms)
    if peak_off_swing and peak_speed < settings.reanchor_min_speed:
        return Measured(slot, reason=PEAK_OFF_ONSET, torso_height=torso,
                        wrist_peak_speed=peak_speed, hitting_side=side,
                        peak_ms=peak_ms)
    contact_ms = track.contact_ms

    wrist_index = (pose_mod.L_WRIST if side == "left" else pose_mod.R_WRIST)
    index = track.nearest_index(contact_ms, slot)
    at_contact = series[index][1]
    mid_x = at_contact.center_x()
    wrist_x, wrist_y = at_contact.xy(wrist_index)
    shoulder_y = (at_contact.points[pose_mod.L_SHOULDER][1]
                  + at_contact.points[pose_mod.R_SHOULDER][1]) / 2.0

    return Measured(
        slot,
        hitting_side=side,
        wrist_peak_speed=peak_speed,
        torso_height=torso,
        # Signed: negative means contact happened left of the midline.
        contact_offset=(wrist_x - mid_x) / torso,
        # Negative means above the shoulder, since y grows downward.
        contact_height=(wrist_y - shoulder_y) / torso,
        peak_ms=peak_ms,
        contact_ms=contact_ms,
        reanchored=False,
        center_x=mid_x,
        boxes=[lm.bbox() for _, lm in series],
    )


def verify(track, settings):
    """Pick the swinging slot in a track and measure it.

    With more than one player in frame, the slot with the fastest wrist is
    the one that hit the ball -- the same logic as choosing an arm, one level
    up. Returns (Measured, all_slot_results).
    """
    slots = track.slot_count()
    if slots == 0:
        return Measured(0, reason=NO_POSE), []

    results = [measure_slot(track, slot, settings) for slot in range(slots)]
    usable = [m for m in results if m.ok]
    if usable:
        return max(usable, key=lambda m: m.wrist_peak_speed), results

    # Nothing usable: report the least-bad reason so the histogram points at
    # the real problem. A frame where a body was found but moved too slowly is
    # more informative than one where no body was found at all.
    order = (WRIST_TOO_SLOW, PEAK_OFF_ONSET, ONSET_OFF_SWING, NO_WRIST_TRACK,
             TORSO_TOO_SMALL, NO_POSE)
    best = min(results, key=lambda m: order.index(m.reason)
               if m.reason in order else len(order))
    return best, results
