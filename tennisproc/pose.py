"""Pose backends: a narrow interface, MediaPipe, and a stub.

Everything downstream consumes `Landmarks` objects and never imports
mediapipe, for two reasons:

  * MediaPipe on macOS needs a window-server session. With CGMainDisplayID()
    == 0 -- ssh, a launchd job, a background process -- it does not raise, it
    *aborts the process* inside DrishtiMetalHelper. Neither delegate=CPU nor
    MEDIAPIPE_DISABLE_GPU works around it. So the import is lazy and there is
    a preflight check that fails with an explanation instead of dying.
  * StubBackend lets the whole ETL run, and be tested, with no display and no
    model file.

Landmark coordinates are normalized to the frame that was passed in
(0..1, origin top-left), which is MediaPipe's own convention.
"""

import ctypes

# The subset of the 33 BlazePose landmarks this pipeline uses.
NOSE = 0
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16
L_HIP, R_HIP = 23, 24
N_LANDMARKS = 33

DEFAULT_MODEL = "models/pose_landmarker_lite.task"


class PoseError(RuntimeError):
    pass


class Landmarks:
    """One detected body in one frame.

    `points` is a list of (x, y, visibility) in frame-normalized coordinates.
    """

    __slots__ = ("points", "score")

    def __init__(self, points, score=1.0):
        self.points = points
        self.score = score

    def xy(self, index):
        p = self.points[index]
        return p[0], p[1]

    def visible(self, index, threshold=0.3):
        return self.points[index][2] >= threshold

    def torso_height(self):
        """Shoulder-to-hip vertical span, the normalization basis.

        Every length and speed downstream is divided by this so that a player
        at the far end of the court is comparable to one near the camera.
        """
        shoulder_y = (self.points[L_SHOULDER][1] + self.points[R_SHOULDER][1]) / 2
        hip_y = (self.points[L_HIP][1] + self.points[R_HIP][1]) / 2
        return abs(hip_y - shoulder_y)

    def center_x(self):
        """Body midline, for deciding which side of the body contact was on."""
        return (self.points[L_SHOULDER][0] + self.points[R_SHOULDER][0]
                + self.points[L_HIP][0] + self.points[R_HIP][0]) / 4

    def bbox(self):
        """(x0, y0, x1, y1) over visible landmarks, frame-normalized."""
        vis = [(p[0], p[1]) for p in self.points if p[2] >= 0.3]
        if not vis:
            vis = [(p[0], p[1]) for p in self.points]
        xs = [p[0] for p in vis]
        ys = [p[1] for p in vis]
        return min(xs), min(ys), max(xs), max(ys)

    def to_json(self):
        return {"score": round(self.score, 4),
                "points": [[round(x, 5), round(y, 5), round(v, 3)]
                           for x, y, v in self.points]}

    @classmethod
    def from_json(cls, data):
        return cls([tuple(p) for p in data["points"]], data.get("score", 1.0))


def has_display():
    """True when a window-server session exists (macOS).

    MediaPipe aborts the process without one, so this is checked before the
    first detection rather than discovered as a crash halfway through a
    300-swing session.
    """
    try:
        cg = ctypes.cdll.LoadLibrary(
            "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    except OSError:
        return True  # not macOS; assume fine
    try:
        return cg.CGMainDisplayID() != 0
    except AttributeError:
        return True


class PoseBackend:
    """Interface: detect bodies in a BGR frame, left to right."""

    name = "base"

    def detect(self, frame, timestamp_ms=None):
        raise NotImplementedError

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class StubBackend(PoseBackend):
    """Synthetic poses, for tests and for running headless.

    Either replays a caller-supplied script keyed by frame index, or -- by
    default -- generates one player whose right wrist swings through an arc,
    so verification and measurement have something plausible to chew on.
    """

    name = "stub"

    def __init__(self, script=None, players=1, swing_at=None):
        self.script = script
        self.players = players
        self.swing_at = swing_at
        self.calls = 0

    def detect(self, frame, timestamp_ms=None):
        index = self.calls
        self.calls += 1
        if self.script is not None:
            return list(self.script[index % len(self.script)])
        return [self._body(index, slot) for slot in range(self.players)]

    def _body(self, index, slot):
        base_x = 0.3 + slot * 0.4
        # Wrist sweeps front to back across the frames it is asked for; the
        # peak lands mid-window, which is where an onset should sit.
        phase = (index % 24) / 24.0
        sweep = -0.18 + 0.36 * phase
        points = [(base_x, 0.5, 0.9)] * N_LANDMARKS
        points = list(points)
        points[NOSE] = (base_x, 0.30, 0.95)
        points[L_SHOULDER] = (base_x - 0.05, 0.40, 0.95)
        points[R_SHOULDER] = (base_x + 0.05, 0.40, 0.95)
        points[L_HIP] = (base_x - 0.04, 0.55, 0.9)
        points[R_HIP] = (base_x + 0.04, 0.55, 0.9)
        points[L_ELBOW] = (base_x - 0.08, 0.48, 0.8)
        points[R_ELBOW] = (base_x + 0.08, 0.48, 0.8)
        # The free arm is parked wide and nearly still; the hitting arm
        # sweeps through a smaller span. That reproduces the trap the old
        # code fell into -- picking the wrist furthest from the midline
        # selects the free arm -- so verify.py's peak-speed rule is tested
        # against the real failure mode rather than a friendly case.
        points[L_WRIST] = (base_x - 0.26, 0.50, 0.8)
        points[R_WRIST] = (base_x + sweep, 0.46, 0.85)
        return Landmarks(points, score=0.9)


class MediaPipeBackend(PoseBackend):
    """MediaPipe Tasks PoseLandmarker, optionally over vertical tiles.

    Tiling exists because a player in a portrait phone video occupies a small
    part of the frame and the detector misses them outright. Overlapping
    vertical strips are each run at full model resolution and the results
    de-duplicated. IMAGE running mode is used when tiling, since VIDEO mode's
    tracker assumes successive frames are the same view.
    """

    name = "mediapipe"

    def __init__(self, model_path=DEFAULT_MODEL, tiles=1, max_people=2,
                 min_confidence=0.4, overlap=0.5):
        if not has_display():
            raise PoseError(
                "MediaPipe needs a window-server session and this process has "
                "none (CGMainDisplayID() == 0). It would abort rather than "
                "raise. Run from a terminal in a logged-in GUI session, or "
                "use --pose-backend=stub.")
        try:
            import mediapipe as mp
        except ImportError as exc:
            raise PoseError("mediapipe not installed: %s" % exc)

        import os
        if not os.path.exists(model_path):
            raise PoseError("pose model not found: %s" % model_path)

        self.tiles = max(1, int(tiles))
        self.overlap = overlap
        self._mp = mp
        base = mp.tasks.BaseOptions(model_asset_path=model_path)
        mode = (mp.tasks.vision.RunningMode.IMAGE if self.tiles > 1
                else mp.tasks.vision.RunningMode.VIDEO)
        self._mode = mode
        options = mp.tasks.vision.PoseLandmarkerOptions(
            base_options=base,
            running_mode=mode,
            num_poses=max_people,
            min_pose_detection_confidence=min_confidence,
            min_pose_presence_confidence=min_confidence,
            min_tracking_confidence=min_confidence)
        self._landmarker = mp.tasks.vision.PoseLandmarker.create_from_options(
            options)

    def _to_mp_image(self, bgr):
        import cv2
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)

    def _detect_whole(self, frame, timestamp_ms):
        image = self._to_mp_image(frame)
        if self._mode == self._mp.tasks.vision.RunningMode.VIDEO:
            result = self._landmarker.detect_for_video(
                image, int(timestamp_ms or 0))
        else:
            result = self._landmarker.detect(image)
        return [self._convert(lms) for lms in (result.pose_landmarks or [])]

    def _convert(self, lms, x_offset=0.0, x_scale=1.0):
        points = [(lm.x * x_scale + x_offset, lm.y,
                   getattr(lm, "visibility", 1.0)) for lm in lms]
        return Landmarks(points, score=1.0)

    def detect(self, frame, timestamp_ms=None):
        if self.tiles <= 1:
            return dedupe(self._detect_whole(frame, timestamp_ms))

        h, w = frame.shape[:2]
        strip_w = int(round(w / (self.tiles - (self.tiles - 1) * self.overlap)))
        step = max(1, int(round(strip_w * (1.0 - self.overlap))))
        found = []
        for i in range(self.tiles):
            x0 = min(i * step, max(0, w - strip_w))
            x1 = min(x0 + strip_w, w)
            if x1 - x0 < 16:
                continue
            image = self._to_mp_image(frame[:, x0:x1])
            result = self._landmarker.detect(image)
            for lms in (result.pose_landmarks or []):
                found.append(self._convert(lms, x_offset=x0 / w,
                                           x_scale=(x1 - x0) / w))
        return dedupe(found)

    def close(self):
        try:
            self._landmarker.close()
        except Exception:
            pass


def dedupe(poses, min_dist=0.05):
    """Drop duplicates from overlapping tiles; return sorted left to right.

    Sorting by x gives slot order a stable meaning across frames, which is
    what lets a player be tracked positionally without identity matching.
    """
    ordered = sorted(poses, key=lambda p: p.center_x())
    kept = []
    for pose in ordered:
        cx, cy = pose.center_x(), pose.points[NOSE][1]
        if any(abs(cx - k.center_x()) < min_dist
               and abs(cy - k.points[NOSE][1]) < min_dist for k in kept):
            continue
        kept.append(pose)
    return kept


def make_backend(name, model_path=DEFAULT_MODEL, tiles=1, min_confidence=0.4,
                 **kwargs):
    if name == "stub":
        return StubBackend(**kwargs)
    if name == "mediapipe":
        return MediaPipeBackend(model_path=model_path, tiles=tiles,
                                min_confidence=min_confidence)
    raise PoseError("unknown pose backend: %s" % name)
