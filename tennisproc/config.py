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
# Verify-stage knobs (min_gap_s, same_place_torsos, min_torso,
# min_wrist_speed), every render knob, and --limit are all deliberately
# absent.
_CACHE_KEYS = ("onset_k", "pose_backend", "pose_window_s", "pose_model",
               "pose_tiles", "pose_min_confidence",
               # The scan decides which candidates exist at all, so every knob
               # that moves a candidate moves the set of windows pose decodes.
               "detector", "scan_fps", "scan_k", "scan_min_gap_s",
               "audio_window_s")


@dataclasses.dataclass
class Settings:
    # --- detection -------------------------------------------------------
    # "vision" scans pose across the whole video and uses audio to place
    # contact; "audio" is the original detector, kept because it is the only
    # one that runs without a pose backend. See `scan.py` for the measurements
    # that made vision the default -- 1.1 candidates per real swing against
    # 3.8, at the same recall.
    detector: str = "vision"
    scan_fps: float = 10.0        # pose sampling rate while looking for swings
    scan_k: float = 3.0           # peak threshold, MADs above median speed
    scan_min_gap_s: float = 1.0   # two peaks closer than this are one swing
    audio_window_s: float = 0.8   # how far a strike may sit from its peak
    # threshold = median + k * MAD. Measured over three sessions against
    # known_shots.json: recall 100/99/98% at k=8, 92/73/74% at k=15. Raised to
    # 15 once on one 72-second clip and it cost a third of the shots elsewhere.
    onset_k: float = 8.0

    # Collapse two swings closer together than this into one. See
    # `pipeline.dedupe_swings`, this knob's only consumer.
    #
    # It was 0.12s, and that number was measured on the wrong population: the
    # closest pair of *audio onsets* in known_shots.json. Onsets are not
    # swings, and since detection went vision-first they are not even
    # candidates -- `scan.corroborate` already thins the snapped contacts to
    # `scan_min_gap_s` = 1.0s apart, so a 0.12s threshold could never fire and
    # never did. Over the 2505 swings in out/, exactly one adjacent pair was
    # under 1.0s apart.
    #
    # What the shipped trees do contain is one stroke reported twice: the
    # wrist peaks again on the follow-through or the racket-bring-around, that
    # second peak finds a nearby sound (the ball on the fence, the next feed
    # leaving the machine) and ships as a swing 1.0-2.0s after the real one.
    # Confirmed frame by frame on IMG_0684 at 28.55s/29.90s and 221.25s/
    # 222.58s: the second "contact" is a player standing with the racket at
    # his chest.
    #
    # 2.0s is bounded on both sides by measurement:
    #
    #   * Above, by what a player can actually do. Across 171 A-B-A triples
    #     where an opponent's shot sits between two shots by the same player
    #     -- so both are certainly real -- the shortest same-player repeat in
    #     the corpus is 2.53s, and the 5th percentile is 3.26s.
    #   * Below, by the duplicates. In the 16 sessions whose ball-machine feed
    #     is periodic enough to fit a lattice (Rayleigh R >= 0.55), 76 adjacent
    #     pairs land in one feed slot, i.e. claim one ball twice. Their gaps
    #     run 1.00-2.01s, median 1.30s, 90th percentile 1.53s.
    #
    # 2.0s sits in the middle of that empty band (1.53 -> 2.53) and removes
    # 10.0% of the corpus, 65 of the 76 slot collisions among them. The
    # remaining 11 sit past 2.0s and are left alone on purpose: 2.5s would
    # catch 3 more and cost 15% of every session.
    min_gap_s: float = 2.0

    # ...but only when both contacts happened in the same place. Two shots
    # a second apart at opposite ends of the court are an exchange, not a
    # double report, and collapsing those was the whole reason a bigger gap
    # looked unaffordable.
    #
    # Measured in torso heights, like every other length here, because a
    # frame fraction means different things at different depths. Over the 597
    # adjacent pairs closer than 2.5s in out/, separation between the two
    # contacts' `center_x`:
    #
    #     same player_slot   n=513   median 0.53 torsos, 90th pct 2.69
    #     different slots    n= 84   MINIMUM 2.12 torsos, median 6.34
    #
    # At 2.0 torsos not one of those 84 two-player pairs is collapsed, while
    # 85% of the same-player pairs stay eligible. Without the test, 39 real
    # exchanges would be merged. It also catches what `player_slot` cannot:
    # IMG_0693 swing_009/010 is two people 1.07s apart in a session the
    # clusterer called single-player, and they measure 2.85 torsos apart.
    same_place_torsos: float = 2.0

    min_torso: float = 0.045      # reject if the body is smaller than this
    min_wrist_speed: float = 0.45  # torso heights per second at contact

    # Speed required when the wrist peak is NOT near the onset: far and slow
    # means nobody swung at that sound. Swept on IMG_0304 -- 100% recall up to
    # 15, precision 32% -> 46%; 20 starts losing shots. One session only.
    reanchor_min_speed: float = 12.0

    # --- pose ------------------------------------------------------------
    pose_window_s: float = 0.40   # decoded either side of the onset
    pose_model: str = "models/pose_landmarker_lite.task"
    # Vertical strips, for a player too small in frame to be detected whole.
    # 0 and 1 both mean "no tiling"; there is no auto-probe, whatever the
    # name once suggested.
    # 3 vertical strips. Detection rate over a 90s slice: 5-12% at 0 tiles on
    # distant/outdoor footage, 77-98% at 3, and 100% either way on the sessions
    # that already worked. Costs ~15x the scan time. NOT 2 -- two strips
    # measured worse than none on three sessions, seams landing on the players.
    pose_tiles: int = 3
    # 0.2, paired with the tiling: a distant player scores lower than a near
    # one. Admits more bodies per frame (1.59 vs 1.00 outdoors) -- the opponent
    # and spectators, which is why player-slot clustering now matters.
    pose_min_confidence: float = 0.2
    pose_backend: str = "mediapipe"

    # --- crop ------------------------------------------------------------
    # "full" renders the whole frame; "pose" crops to the tracked player.
    #
    # Default "full", because the pose crop is measured over `pose_window_s`
    # -- +-0.4s -- and then applied to everything: a 3.5s clip and, at
    # `--fps 2 --span 3.0`, stills reaching +-1.5s. IMG_0304/swing_015 came out
    # a 404x764 strip the player entered around -0.5s and left by +1.5s, so its
    # first still is an empty court. Padding cannot fix that; the problem is the
    # fraction of the clip the box was measured over, not its size.
    #
    # "pose" is still right when the frame span is inside the pose window, where
    # a tight frame on the body is exactly what a reviewer wants.
    crop_mode: str = "full"
    # --- clip ------------------------------------------------------------
    pre_s: float = 1.5            # clip starts this far before contact
    post_s: float = 2.0           # ...and ends this far after
    clip_height: int = 0          # 0 = keep the source resolution
    clip_crf: int = 26

    # The session proxy: one browser-playable transcode of the WHOLE source,
    # which the review app seeks in. Defaults keep the source resolution and
    # frame rate -- the proxy exists to change the codec, not the footage.
    proxy: bool = True
    proxy_crf: int = 20           # libx264 only; videotoolbox uses a bitrate
    proxy_height: int = 0         # 0 = keep the source resolution
    proxy_fps: float = 0.0        # 0 = keep the source frame rate

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
        if self.same_place_torsos < 0:
            errs.append("same_place_torsos must be >= 0")
        if self.min_torso < 0:
            errs.append("min_torso must be >= 0")
        if self.min_wrist_speed < 0:
            errs.append("min_wrist_speed must be >= 0")
        if self.reanchor_min_speed < 0:
            errs.append("reanchor_min_speed must be >= 0")
        if self.pose_window_s <= 0:
            errs.append("pose_window_s must be > 0")
        if self.pose_tiles < 0:
            errs.append("pose_tiles must be >= 0")
        if not 0 <= self.pose_min_confidence <= 1:
            errs.append("pose_min_confidence must be 0..1")
        if self.pre_s <= 0 or self.post_s <= 0:
            errs.append("pre_s and post_s must be > 0")
        if self.clip_height < 0:
            errs.append("clip_height must be >= 0")
        if not 0 <= self.clip_crf <= 51:
            errs.append("clip_crf must be 0..51")
        if not 0 <= self.proxy_crf <= 51:
            errs.append("proxy_crf must be 0..51")
        if self.proxy_height < 0:
            errs.append("proxy_height must be >= 0")
        if self.proxy_fps < 0:
            errs.append("proxy_fps must be >= 0 (0 means the source rate)")
        if self.detector not in ("vision", "audio"):
            errs.append("detector must be 'vision' or 'audio'")
        if self.scan_fps <= 0:
            errs.append("scan_fps must be > 0")
        if self.scan_k <= 0:
            errs.append("scan_k must be > 0")
        if self.scan_min_gap_s < 0:
            errs.append("scan_min_gap_s must be >= 0")
        if self.audio_window_s <= 0:
            errs.append("audio_window_s must be > 0")
        if self.crop_mode not in ("full", "pose"):
            errs.append("crop_mode must be 'full' or 'pose'")
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
