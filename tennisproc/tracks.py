"""One decode pass per candidate, yielding one landmark track.

The previous generation of this code decoded each candidate window twice:
once through MediaPipe to decide whether a swing happened, and again through
three-frame motion differencing to find a crop box. It ended up with three
near-duplicate motion-box implementations and two sources of truth for where
the player was.

Here a candidate is decoded once. Verification, the crop box, the player's
position and every measurement all derive from the same track.

Rotation is normalized here, immediately after decode, and nowhere else.
OpenCV 5.0 auto-rotates by default (CAP_PROP_ORIENTATION_AUTO == 1) while
older versions did not, so relying on the library default would make frame
orientation depend on the installed OpenCV. Instead auto-rotation is turned
off and the rotation from probe() is applied explicitly, which was verified
to reproduce ffmpeg's own decode.
"""

import gzip
import json

from . import pose as pose_mod


class Track:
    """Landmark detections for one candidate, over a window of frames.

    frames: list of {"source_ms": int, "poses": [Landmarks]}
    """

    __slots__ = ("candidate", "frames", "frame_size")

    def __init__(self, candidate, frames, frame_size=None):
        self.candidate = candidate
        self.frames = frames
        self.frame_size = frame_size

    @property
    def contact_ms(self):
        return self.candidate["contact_ms"]

    def detected_count(self):
        return sum(1 for f in self.frames if f["poses"])

    def slot_count(self):
        return max((len(f["poses"]) for f in self.frames), default=0)

    def series(self, slot=0):
        """[(source_ms, Landmarks)] for one positional slot, skipping misses."""
        out = []
        for frame in self.frames:
            if len(frame["poses"]) > slot:
                out.append((frame["source_ms"], frame["poses"][slot]))
        return out

    def nearest_index(self, source_ms, slot=0):
        """Index into series(slot) closest to the given time, or None."""
        rows = self.series(slot)
        if not rows:
            return None
        return min(range(len(rows)), key=lambda i: abs(rows[i][0] - source_ms))

    def to_json(self):
        return {
            "candidate": self.candidate,
            "frame_size": list(self.frame_size) if self.frame_size else None,
            "frames": [{"source_ms": f["source_ms"],
                        "poses": [p.to_json() for p in f["poses"]]}
                       for f in self.frames],
        }

    @classmethod
    def from_json(cls, data):
        frames = [{"source_ms": f["source_ms"],
                   "poses": [pose_mod.Landmarks.from_json(p)
                             for p in f["poses"]]}
                  for f in data["frames"]]
        size = data.get("frame_size")
        return cls(data["candidate"], frames,
                   tuple(size) if size else None)


ROTATE_CODES = {90: "ROTATE_90_CLOCKWISE", 180: "ROTATE_180",
                270: "ROTATE_90_COUNTERCLOCKWISE"}


def rotate_frame(frame, rotation, cv2):
    """Apply clockwise `rotation` degrees to a decoded frame.

    `rotation` comes from probe(): the turn needed to get from coded to
    display orientation.
    """
    if not rotation:
        return frame
    code = ROTATE_CODES.get(rotation % 360)
    if code is None:
        return frame
    return cv2.rotate(frame, getattr(cv2, code))


def open_capture(video, cv2):
    """A VideoCapture with auto-rotation disabled, so we control orientation."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError("could not open %s" % video)
    try:
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)
    except Exception:
        pass  # older OpenCV: no auto-rotation to disable
    return cap


def extract_track(video, candidate, source, backend, window_s=0.40, cv2=None):
    """Decode one candidate window and detect poses in every frame.

    Frames are timestamped by their real presentation time, read back from
    the decoder, not computed from an index -- variable frame rate would make
    an index-derived time drift.
    """
    if cv2 is None:
        import cv2 as cv2_mod
        cv2 = cv2_mod

    contact_ms = candidate["contact_ms"]
    start_ms = max(0, contact_ms - int(window_s * 1000))
    end_ms = min(source["duration_ms"], contact_ms + int(window_s * 1000))

    cap = open_capture(video, cv2)
    frames = []
    frame_size = None
    decoded = 0
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(start_ms))
        while True:
            position_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            ok, raw = cap.read()
            if not ok:
                break
            if position_ms is None or position_ms <= 0:
                # Counted from frames *decoded*, not frames kept: the skip
                # below can drop some, and len(frames) would then understate
                # how far the decoder has actually advanced.
                position_ms = start_ms + decoded * (1000.0 / source["fps"])
            decoded += 1
            if position_ms > end_ms:
                break
            # A msec seek lands on or *before* the requested time -- with a
            # long GOP, potentially seconds before. Without this the window
            # silently widens on one side: every early frame gets a pose
            # detection (the expensive call) and its bbox joins the crop
            # union, so the rectangle grows to cover the player walking into
            # position rather than the swing.
            if position_ms < start_ms:
                continue
            frame = rotate_frame(raw, source.get("rotation", 0), cv2)
            if frame_size is None:
                frame_size = (frame.shape[1], frame.shape[0])
            poses = backend.detect(frame, int(round(position_ms)))
            frames.append({"source_ms": int(round(position_ms)),
                           "poses": poses})
    finally:
        cap.release()

    return Track(candidate, frames, frame_size)


def write_cache(path, tracks, cache_hash):
    """Persist tracks so re-running a later stage never re-runs pose."""
    with gzip.open(str(path), "wt", encoding="utf-8") as fh:
        fh.write(json.dumps({"cache_hash": cache_hash}) + "\n")
        for track in tracks:
            fh.write(json.dumps(track.to_json()) + "\n")


def read_cache(path, cache_hash):
    """Load cached tracks, or None if absent or built with other settings."""
    try:
        with gzip.open(str(path), "rt", encoding="utf-8") as fh:
            header = json.loads(fh.readline())
            if header.get("cache_hash") != cache_hash:
                return None
            return [Track.from_json(json.loads(line)) for line in fh if line.strip()]
    except (OSError, ValueError, KeyError, EOFError):
        # EOFError is not an OSError: a run killed mid-write leaves a torn
        # gzip that crashed every later run. A torn cache reads as absent.
        return None


BODY_JUMP = pose_mod.BODY_JUMP


def _nearest_body(poses, previous):
    """The pose continuing `previous`, or the largest when starting fresh."""
    if previous is not None:
        last_x = previous.center_x()
        nearest = min(poses, key=lambda p: abs(p.center_x() - last_x))
        if abs(nearest.center_x() - last_x) <= BODY_JUMP:
            return nearest
    return max(poses, key=lambda p: p.torso_height() or 0.0)


def scan_video(video, source, backend, scan_fps=10.0, cv2=None, on_progress=None):
    """Pose across the WHOLE video at a low rate, for finding swings.

    One linear read rather than a seek per candidate, which is both faster
    (4.5x realtime) and what lets the body decide a swing happened. Wrists and
    torso only; survivors are decoded again at native rate for measurement.
    """
    if cv2 is None:
        import cv2 as cv2_mod
        cv2 = cv2_mod

    step_ms = 1000.0 / float(scan_fps) if scan_fps > 0 else 0.0
    cap = open_capture(video, cv2)
    samples = []
    next_ms = 0.0
    previous = None
    try:
        while True:
            ok, raw = cap.read()
            if not ok:
                break
            position_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if position_ms is None or position_ms < next_ms:
                continue
            next_ms = position_ms + step_ms
            frame = rotate_frame(raw, source.get("rotation", 0), cv2)
            poses = backend.detect(frame, int(round(position_ms)))
            if not poses:
                continue
            # Follow ONE body, rather than taking the largest in each frame
            # independently. With two players and spectators in frame the
            # winner flips, and a flip moves the "wrist" across the court in
            # one sample: measured at 17.5 torso-heights/s against 8.25 for the
            # strongest real swing, so every flip both invents a candidate and
            # suppresses the real swings within a second of it.
            landmarks = _nearest_body(poses, previous)
            centre = landmarks.center_x()
            samples.append({
                "ms": int(round(position_ms)),
                "lw": landmarks.xy(pose_mod.L_WRIST),
                "rw": landmarks.xy(pose_mod.R_WRIST),
                "torso": landmarks.torso_height(),
                "cx": centre,
            })
            previous = landmarks
            if on_progress is not None and len(samples) % 250 == 0:
                on_progress(len(samples), position_ms)
    finally:
        cap.release()
    return samples
