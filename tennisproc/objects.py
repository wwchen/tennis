"""Racket and ball, from a COCO-pretrained detector.

Neither object needs training or labelling: `tennis racket` and `sports ball`
are two of COCO's eighty classes, so a stock YOLO already knows both.

Two things had to be measured rather than assumed, and both are recorded
beside the constant they chose.

**Which racket box belongs to the player.** A raw detection is not enough --
over 108 swings of IMG_0684, 39 racket boxes sat more than 1.9 torso heights
from the hitting wrist, and of those 0% were on the second person in frame,
25.6% were on the player with a misplaced pose wrist, and 74.4% were on
nothing at all.

**Whether a ball is in flight.** The court fills with dead balls as a session
runs and a stock detector finds them all: at control moments at least 5 s from
any shot it still reported a ball 79.2% of the time. Detection alone therefore
says almost nothing. Motion against a short background plate separates them --
a ball at 15 m/s covers most of a torso height between frames, one lying on
the court is in every plate frame and cancels.

The converse also holds, which is why neither half is used alone: a plate-only
test cannot tell a ball from a shoe, since a heel is bright, convex,
ball-sized at this scale and moving. Composed, hand adjudication put the pair
at 8/8 across motion scores 21 to 65.
"""

import numpy as np

from .errors import TennisprocError


class ObjectError(TennisprocError):
    pass


# COCO's contiguous 80-class ordering, which is what YOLO emits. NOT the COCO
# category ids, which run 1-90 with gaps and put these at 37 and 43 -- the two
# numberings are not one apart and converting by subtraction is wrong.
COCO_PERSON = 0
COCO_SPORTS_BALL = 32
COCO_TENNIS_RACKET = 38

# Inference width. Measured on IMG_0684's contact frames, racket found within
# reach of the hand: 48.1% at 640, 53.7% at 1280, 53.7% at 1920. At 640 a
# 1080x1920 frame is squashed threefold and a motion-blurred racket stops
# looking like one -- on the first frame this was checked against, 640 found no
# racket at all. 1920 buys nothing over 1280 and costs twice the time.
IMGSZ = 1280

# Detection floor, deliberately low. Boxes at confidence 0.12 and 0.22 were
# both confirmed correct by hand; raising the floor to 0.25 costs about ten
# points of recall to remove detections that are right. Confidence barely
# separates good boxes from bad here anyway -- median 0.74 on boxes near the
# hand against 0.67 on the false ones.
CONF = 0.10

# A racket held at the butt puts its head about one torso height beyond the
# wrist and its tip about 1.5. 1.9 leaves room for pose error without
# admitting the net cord.
RACKET_REACH = 1.9
# Fraction of a racket box that must fall inside the player's box to be theirs.
PLAYER_OVERLAP = 0.30

# Frames either side used to build the short plate. A ball at 15 m/s covers
# roughly 90 px per frame at this scale, so four frames away it is nowhere near
# its own position, while anything stationary for a fifth of a second is in
# every one of them.
PLATE_OFFSETS = (-6, -4, 4, 6)

# Mean per-pixel deviation from that plate, 0-255, above which a detected ball
# counts as in flight. Swept against a control at least 5 s from any shot:
#
#     threshold   at contact   at control   lift
#        10         69.4%        45.5%      +23.9
#        20         59.3%        31.7%      +27.6
#        40         34.3%        13.9%      +20.4
#        50         16.7%         3.0%      +13.7
#
# 20 is the peak, and it was checked at its own boundary rather than in the
# comfortable middle: a candidate scoring 21 was confirmed by hand to be a real
# ball in flight. Dead balls on the court score 2-3.
#
# BUT that lift is session-dependent, and this is the least trustworthy
# constant in this file. Re-measured over 24 swings each of four other
# sessions the per-session lift runs -13, +21, +32, +46 -- on IMG_0689 the
# control fires MORE often than contact, making the test worse than useless
# there. The aggregate over 96 swings is +22, close to the figure above, so the
# threshold is not obviously wrong; what is wrong is treating any single ball
# detection as evidence on a session nobody has checked. Swing density does not
# explain the spread. See tennisproc/README.md, "Racket and ball".
BALL_MOTION = 20.0

# Blob area in torso heights squared. A 6.7 cm ball against a ~48 cm torso
# covers about 0.015 face-on; motion blur stretches a streak without widening
# it, so the ceiling is generous and the floor is what keeps out compression
# speckle.
BALL_AREA = (0.002, 0.075)


class Box:
    """One detection, in source-display pixels."""

    __slots__ = ("x1", "y1", "x2", "y2", "conf")

    def __init__(self, x1, y1, x2, y2, conf=1.0):
        self.x1, self.y1 = float(x1), float(y1)
        self.x2, self.y2 = float(x2), float(y2)
        self.conf = float(conf)

    @property
    def centre(self):
        return ((self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0)

    @property
    def area(self):
        return max(0.0, self.x2 - self.x1) * max(0.0, self.y2 - self.y1)

    def distance_to(self, point):
        """0 when the point is inside, else distance to the nearest edge."""
        x, y = point
        dx = max(self.x1 - x, 0.0, x - self.x2)
        dy = max(self.y1 - y, 0.0, y - self.y2)
        return float(np.hypot(dx, dy))

    def overlap_fraction(self, other):
        """How much of THIS box falls inside `other`."""
        if self.area <= 0:
            return 0.0
        w = max(0.0, min(self.x2, other.x2) - max(self.x1, other.x1))
        h = max(0.0, min(self.y2, other.y2) - max(self.y1, other.y1))
        return (w * h) / self.area

    def to_metadata(self):
        return {"x": round(self.x1, 1), "y": round(self.y1, 1),
                "w": round(self.x2 - self.x1, 1),
                "h": round(self.y2 - self.y1, 1),
                "conf": round(self.conf, 3)}


def choose_player(persons, pose_box):
    """The detected person the tracked player's pose sits inside."""
    if not persons or pose_box is None:
        return None
    return max(persons, key=lambda p: pose_box.overlap_fraction(p))


def choose_racket(rackets, wrist, player, torso_px):
    """The racket the tracked player is holding, or None.

    Accepted when near the wrist OR on the player, not both. Measured over 108
    swings, recall was 53.7% for the wrist test alone, 38.9% for the overlap
    test alone and 62.0% for either -- because the wrist test survives a bad
    player box and the overlap test survives a bad wrist, and a quarter of the
    far-from-wrist boxes were exactly that second case.
    """
    if not rackets or torso_px <= 0:
        return None
    keep = []
    for box in rackets:
        near = (wrist is not None
                and box.distance_to(wrist) <= RACKET_REACH * torso_px)
        held = (player is not None
                and box.overlap_fraction(player) >= PLAYER_OVERLAP)
        if near or held:
            keep.append(box)
    return max(keep, key=lambda b: b.conf) if keep else None


def short_plate(frames):
    """Median of frames sampled either side of the moment of interest."""
    usable = [f for f in frames if f is not None]
    if len(usable) < 3:
        return None
    shapes = {f.shape for f in usable}
    if len(shapes) != 1:
        raise ObjectError("plate frames differ in shape: %r" % (sorted(shapes),))
    return np.median(np.stack(usable), axis=0).astype(np.uint8)


def motion_score(frame, plate, box):
    """Mean absolute deviation from the plate inside `box`, 0-255."""
    y0, y1 = max(0, int(box.y1)), max(0, int(np.ceil(box.y2)))
    x0, x1 = max(0, int(box.x1)), max(0, int(np.ceil(box.x2)))
    patch, ref = frame[y0:y1, x0:x1], plate[y0:y1, x0:x1]
    if patch.size == 0 or patch.shape != ref.shape:
        return 0.0
    return float(np.abs(patch.astype(np.int16)
                        - ref.astype(np.int16)).mean())


def choose_ball(balls, frame, plate, torso_px):
    """The ball in flight as (Box, motion_score), or None.

    Detection alone is not evidence: a stock detector finds every dead ball on
    the court, and did so at 79.2% of moments when nothing was being struck.
    """
    if not balls or plate is None or torso_px <= 0:
        return None
    scored = []
    for box in balls:
        area = box.area / float(torso_px * torso_px)
        if not BALL_AREA[0] <= area <= BALL_AREA[1]:
            continue
        score = motion_score(frame, plate, box)
        if score >= BALL_MOTION:
            scored.append((box, score))
    return max(scored, key=lambda pair: pair[1]) if scored else None


class ObjectBackend:
    """Interface: find rackets, balls and people in one BGR frame."""

    name = "base"

    def detect(self, frame):
        """-> {"racket": [Box], "ball": [Box], "person": [Box]}"""
        raise NotImplementedError

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


EMPTY = {"racket": [], "ball": [], "person": []}


class StubObjectBackend(ObjectBackend):
    """Replays a caller-supplied script, so the pipeline runs with no model."""

    name = "stub"

    def __init__(self, script=None):
        self.script = list(script or [])
        self.calls = 0

    def detect(self, frame):
        index = self.calls
        self.calls += 1
        if not self.script:
            return dict(EMPTY)
        return self.script[index % len(self.script)]


class YoloBackend(ObjectBackend):
    """Ultralytics YOLO on stock COCO weights, no fine-tuning.

    Ultralytics is AGPL-3.0, which is fine for private use and a problem for
    redistribution. That is why this is an optional backend chosen by flag
    rather than a dependency in requirements.txt.
    """

    name = "yolo"

    CLASSES = {COCO_TENNIS_RACKET: "racket", COCO_SPORTS_BALL: "ball",
               COCO_PERSON: "person"}

    def __init__(self, weights="yolo11x.pt", imgsz=IMGSZ, conf=CONF,
                 device=None):
        try:
            from ultralytics import YOLO
        except ImportError as exc:
            raise ObjectError(
                "ultralytics not installed: %s. Install with "
                "`pip install ultralytics`; COCO weights download on first "
                "use." % exc)
        self.imgsz, self.conf = int(imgsz), float(conf)
        self.device = device or self._best_device()
        self._model = YOLO(weights)

    @staticmethod
    def _best_device():
        try:
            import torch
        except ImportError:
            return "cpu"
        try:
            if torch.backends.mps.is_available():
                return "mps"
            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def detect(self, frame):
        result = self._model.predict(frame, imgsz=self.imgsz, conf=self.conf,
                                     verbose=False, device=self.device)[0]
        out = {"racket": [], "ball": [], "person": []}
        for b in result.boxes:
            key = self.CLASSES.get(int(b.cls[0]))
            if key is None:
                continue
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0])
            out[key].append(Box(x1, y1, x2, y2, float(b.conf[0])))
        return out


def make_backend(name, **kwargs):
    """Build a backend by name. "none" means the stage does not run."""
    if name in (None, "none"):
        return None
    if name == "stub":
        return StubObjectBackend(**kwargs)
    if name == "yolo":
        return YoloBackend(**kwargs)
    raise ObjectError("unknown object backend: %s" % name)


def measure(backend, frame, plate, pose_box, wrist, torso_px):
    """Racket and ball for one swing, as the `objects` metadata block.

    `frame` is the contact frame and `plate` the short-plate median of frames
    either side of it. Both are in source-display orientation, like every
    other pixel coordinate this package writes.
    """
    found = backend.detect(frame)
    player = choose_player(found.get("person"), pose_box)
    racket = choose_racket(found.get("racket"), wrist, player, torso_px)
    ball = choose_ball(found.get("ball"), frame, plate, torso_px)
    doc = {"space": "source_display",
           "detector": "%s/coco" % backend.name,
           "racket": racket.to_metadata() if racket else None,
           "ball": None}
    if ball is not None:
        box, score = ball
        doc["ball"] = dict(box.to_metadata(), motion=round(score, 1))
        if racket is not None:
            doc["ball"]["racket_distance"] = round(
                racket.distance_to(box.centre) / torso_px, 3)
    return doc
