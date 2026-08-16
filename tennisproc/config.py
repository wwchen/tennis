"""Resolved settings for one ETL run.

Every tunable lives here with its default. `settings_hash` is part of the
cache key for the expensive stages, so changing a knob that affects pose or
frame extraction invalidates the cache automatically rather than silently
reusing stale work.
"""

import dataclasses
import hashlib
import json

# Which settings actually change the cached artifacts. Changing --jobs or
# --limit must not throw away a pose pass that is still valid.
_CACHE_KEYS = ("onset_k", "min_gap_s", "pose_window_s", "pose_model",
               "pose_tiles", "pose_min_confidence", "min_torso")


@dataclasses.dataclass
class Settings:
    # --- detection -------------------------------------------------------
    onset_k: float = 8.0          # threshold = median + k * MAD

    # Collapse candidates closer together than this.
    #
    # Sized from real footage rather than intuition, because every plausible
    # guess was wrong. Measured over 351 pose-verified shots in three real
    # sessions, the closest genuine pair is 0.12s apart and the 10th
    # percentile is 0.14s -- players hit far faster than feels believable
    # (volley exchanges, a ball worked back off the fence). Discard rates for
    # candidate thresholds:
    #
    #     0.12s ->   0%      0.25s -> 31%      0.35s -> 38%
    #     0.15s ->  15%      0.30s -> 36%      3.50s -> 60%+
    #
    # So this is deliberately near-inert: `audio.REFRACTORY_S` already
    # suppresses a strike's own echo inside the onset detector, which is the
    # job this looked like it should do. Raise it only if a specific video
    # double-reports, and check what it costs first.
    min_gap_s: float = 0.12

    min_torso: float = 0.045      # reject if the body is smaller than this
    min_wrist_speed: float = 0.45  # torso heights per second at contact

    # --- pose ------------------------------------------------------------
    pose_window_s: float = 0.40   # decoded either side of the onset
    pose_model: str = "models/pose_landmarker_lite.task"
    pose_tiles: int = 0           # 0 = probe automatically
    pose_min_confidence: float = 0.4
    pose_backend: str = "mediapipe"

    # --- clip ------------------------------------------------------------
    pre_s: float = 1.5            # clip starts this far before contact
    post_s: float = 2.0           # ...and ends this far after
    clip_height: int = 480
    clip_crf: int = 26

    # --- frames ----------------------------------------------------------
    # Native fps over a tight span: a human relabelling the true contact
    # frame cannot do it on a sparse grid, since the ball moves feet between
    # frames at 30fps. 0.0 means "use the source fps".
    frame_span_s: float = 1.6     # total, centred on contact
    frame_fps: float = 0.0
    frame_long_edge: int = 640
    frame_quality: int = 88
    crop_pad: float = 0.18

    # --- players ---------------------------------------------------------
    player_mode: str = "side"     # side | depth
    player_count: int = 0         # 0 = auto

    # --- run -------------------------------------------------------------
    jobs: int = 4
    limit: int = 0                # 0 = all

    def frames_per_swing(self, source_fps):
        fps = self.frame_fps or source_fps
        return int(round(self.frame_span_s * fps)) + 1

    def to_dict(self):
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data):
        known = {f.name for f in dataclasses.fields(cls)}
        unknown = set(data) - known - {"settings_hash"}
        if unknown:
            raise ValueError("unknown settings: %s" % sorted(unknown))
        return cls(**{k: v for k, v in data.items() if k in known})

    def cache_hash(self):
        """Hash of only the settings that affect cached artifacts."""
        payload = {k: getattr(self, k) for k in _CACHE_KEYS}
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

    def as_metadata(self):
        """The `settings` block of a SessionDoc."""
        out = self.to_dict()
        out["settings_hash"] = self.cache_hash()
        return out

    def validate(self):
        errs = []
        if self.onset_k <= 0:
            errs.append("onset_k must be > 0")
        if self.pre_s <= 0 or self.post_s <= 0:
            errs.append("pre_s and post_s must be > 0")
        if self.frame_span_s <= 0:
            errs.append("frame_span_s must be > 0")
        if not 1 <= self.frame_quality <= 100:
            errs.append("frame_quality must be 1..100")
        if self.player_mode not in ("side", "depth"):
            errs.append("player_mode must be side or depth")
        if self.pose_backend not in ("mediapipe", "stub", "none"):
            errs.append("pose_backend must be mediapipe, stub or none")
        if self.crop_pad < 0:
            errs.append("crop_pad must be >= 0")
        return errs
