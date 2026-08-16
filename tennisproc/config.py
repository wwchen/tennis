"""Resolved settings for one ETL run.

Every tunable lives here with its default. `settings_hash` is part of the
cache key for the one cached stage -- pose -- so changing a knob that feeds
it invalidates the cache automatically rather than silently reusing stale
work. Nothing else caches; render always re-runs.
"""

import dataclasses
import hashlib
import json

# Which settings actually change the *pose cache*, the only cached artifact.
# Two rules, both of which have bitten:
#
#   * Anything the pose pass consumes must be listed. `pose_backend` was
#     not, so a headless `--pose-backend=stub` run wrote a cache of
#     synthetic stick figures that a later real MediaPipe run read straight
#     back -- every crop, hitting-side call and measurement came from the
#     stub, with no warning.
#   * Anything it does not consume must not be listed, or tuning a cheap
#     knob discards an expensive pass. `min_gap_s` and `min_torso` were
#     here despite being verify-stage only, so sweeping --gap re-ran pose
#     for nothing.
#
# Verify-stage knobs (min_gap_s, min_torso, min_wrist_speed), every render
# knob, and --limit are all deliberately absent.
_CACHE_KEYS = ("onset_k", "pose_backend", "pose_window_s", "pose_model",
               "pose_tiles", "pose_min_confidence")


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
    # Vertical strips, for a player too small in frame to be detected whole.
    # 0 and 1 both mean "no tiling"; there is no auto-probe, whatever the
    # name once suggested.
    pose_tiles: int = 0
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
    limit: int = 0                # 0 = all

    def frames_per_swing(self, source_fps):
        """How many stills `render.frame_times_ms` will ask for.

        Must mirror that function exactly: it builds the grid outward from
        contact, so the count is 2*half+1, not round(span*fps)+1. The two
        disagreed by one whenever span*fps landed on an odd integer
        (--span 0.5 at 30fps: 16 predicted, 17 written).

        This is the count *requested*. Times outside the video are dropped,
        so a swing near either end yields fewer.
        """
        fps = self.frame_fps or source_fps
        if fps <= 0:
            return 1
        half = max(1, int(round((self.frame_span_s / 2.0) * fps)))
        return 2 * half + 1

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
        """Every knob that can fail downstream, checked before pose runs.

        The point is to fail in the first second rather than after a
        half-hour pose pass: an unvalidated --clip-height of -10 used to
        reach ffmpeg as `scale=-2:-10` and blow up at render time.
        """
        errs = []
        if self.onset_k <= 0:
            errs.append("onset_k must be > 0")
        if self.min_gap_s < 0:
            errs.append("min_gap_s must be >= 0")
        if self.min_torso < 0:
            errs.append("min_torso must be >= 0")
        if self.min_wrist_speed < 0:
            errs.append("min_wrist_speed must be >= 0")
        if self.pose_window_s <= 0:
            errs.append("pose_window_s must be > 0")
        if self.pose_tiles < 0:
            errs.append("pose_tiles must be >= 0")
        if not 0 <= self.pose_min_confidence <= 1:
            errs.append("pose_min_confidence must be 0..1")
        if self.pre_s <= 0 or self.post_s <= 0:
            errs.append("pre_s and post_s must be > 0")
        if self.clip_height <= 0:
            errs.append("clip_height must be > 0")
        if not 0 <= self.clip_crf <= 51:
            errs.append("clip_crf must be 0..51")
        if self.frame_span_s <= 0:
            errs.append("frame_span_s must be > 0")
        if self.frame_fps < 0:
            errs.append("frame_fps must be >= 0 (0 means the source rate)")
        if self.frame_long_edge <= 0:
            errs.append("frame_long_edge must be > 0")
        if not 1 <= self.frame_quality <= 100:
            errs.append("frame_quality must be 1..100")
        if self.player_mode not in ("side", "depth"):
            errs.append("player_mode must be side or depth")
        if self.player_count not in (0, 1, 2):
            errs.append("player_count must be 0 (auto), 1 or 2")
        # Only what make_backend() can actually build. "none" used to pass
        # here and then raise PoseError several stages later.
        if self.pose_backend not in ("mediapipe", "stub"):
            errs.append("pose_backend must be mediapipe or stub")
        if self.crop_pad < 0:
            errs.append("crop_pad must be >= 0")
        if self.limit < 0:
            errs.append("limit must be >= 0 (0 means all)")
        return errs
