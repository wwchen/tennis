"""Was this audio candidate actually a swing? And which arm swung?

Two jobs, both derived from the single landmark track:

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
ONSET_OFF_SWING = "onset_off_swing"

MIN_DETECTED_FRAMES = 4
# A wrist that jumps implausibly far between frames is a detector glitch, not
# a limb: cap it rather than letting one bad frame dominate peak speed.
SPEED_CAP = 40.0


class Measured:
    """Per-slot swing measurements, or a reason the slot is unusable."""

    __slots__ = ("slot", "reason", "hitting_side", "wrist_peak_speed",
                 "torso_height", "contact_offset", "contact_height",
                 "peak_ms", "center_x", "boxes")

    def __init__(self, slot, reason=None, hitting_side=None,
                 wrist_peak_speed=None, torso_height=None,
                 contact_offset=None, contact_height=None, peak_ms=None,
                 center_x=None, boxes=None):
        self.slot = slot
        self.reason = reason
        self.hitting_side = hitting_side
        self.wrist_peak_speed = wrist_peak_speed
        self.torso_height = torso_height
        self.contact_offset = contact_offset
        self.contact_height = contact_height
        self.peak_ms = peak_ms
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


def wrist_speeds(series, wrist_index, torso):
    """[(source_ms, speed)] for one wrist, in torso heights per second.

    Speed is measured over the interval *centred* on each sample, so a peak
    lands on the frame where the wrist is fastest rather than half an
    interval late.
    """
    if len(series) < 2 or torso <= 0:
        return []
    out = []
    for i in range(len(series)):
        j0 = max(0, i - 1)
        j1 = min(len(series) - 1, i + 1)
        if j1 == j0:
            continue
        t0, a = series[j0]
        t1, b = series[j1]
        dt = (t1 - t0) / 1000.0
        if dt <= 0:
            continue
        ax, ay = a.xy(wrist_index)
        bx, by = b.xy(wrist_index)
        dist = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 / torso
        out.append((series[i][0], min(dist / dt, SPEED_CAP)))
    return out


def choose_hitting_side(series, torso):
    """Return ("left"|"right", peak_speed, peak_ms) by peak wrist speed.

    Not by reach. See the module docstring: reach selects the free arm.
    """
    best = (None, -1.0, None)
    for side, index in (("left", pose_mod.L_WRIST),
                        ("right", pose_mod.R_WRIST)):
        speeds = wrist_speeds(series, index, torso)
        if not speeds:
            continue
        peak_ms, peak = max(speeds, key=lambda row: row[1])
        if peak > best[1]:
            best = (side, peak, peak_ms)
    return best


def measure_slot(track, slot, settings):
    """Measure one positional slot of a track."""
    series = track.series(slot)
    if len(series) < MIN_DETECTED_FRAMES:
        return Measured(slot, reason=NO_POSE)

    torsos = [lm.torso_height() for _, lm in series]
    torso = _median(torsos)
    if torso < settings.min_torso:
        return Measured(slot, reason=TORSO_TOO_SMALL, torso_height=torso)

    side, peak_speed, peak_ms = choose_hitting_side(series, torso)
    if side is None:
        return Measured(slot, reason=NO_WRIST_TRACK, torso_height=torso)
    if peak_speed < settings.min_wrist_speed:
        return Measured(slot, reason=WRIST_TOO_SLOW, torso_height=torso,
                        wrist_peak_speed=peak_speed, hitting_side=side,
                        peak_ms=peak_ms)

    # The onset should coincide with the swing, not sit outside it. A ball
    # bouncing near a stationary player would otherwise pass.
    window_ms = settings.pose_window_s * 1000.0
    if peak_ms is not None and abs(peak_ms - track.contact_ms) > window_ms:
        return Measured(slot, reason=ONSET_OFF_SWING, torso_height=torso,
                        wrist_peak_speed=peak_speed, hitting_side=side,
                        peak_ms=peak_ms)

    wrist_index = (pose_mod.L_WRIST if side == "left" else pose_mod.R_WRIST)
    index = track.nearest_index(track.contact_ms, slot)
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
    order = (WRIST_TOO_SLOW, ONSET_OFF_SWING, NO_WRIST_TRACK,
             TORSO_TOO_SMALL, NO_POSE)
    best = min(results, key=lambda m: order.index(m.reason)
               if m.reason in order else len(order))
    return best, results
