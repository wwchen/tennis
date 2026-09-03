"""Tests for probe.py and config.py, against real ffmpeg-written files."""

import dataclasses
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import config, probe, schema

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def make_video(path, w=320, h=240, rotation=None, duration=2, fps=30,
               audio=True):
    """Write a real test video, optionally with a display-matrix rotation."""
    cmd = ["ffmpeg", "-v", "error",
           "-f", "lavfi", "-i",
           "testsrc=size=%dx%d:rate=%d:duration=%d" % (w, h, fps, duration)]
    if audio:
        cmd += ["-f", "lavfi", "-i",
                "sine=frequency=440:duration=%d" % duration]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac"] if audio else ["-an"]
    cmd += ["-y", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    if rotation is None:
        return path
    rotated = Path(str(path).replace(".mp4", "_rot.mp4"))
    subprocess.run(["ffmpeg", "-v", "error", "-display_rotation",
                    str(rotation), "-i", str(path), "-c", "copy",
                    "-y", str(rotated)], check=True, capture_output=True)
    return rotated


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestProbe(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_probes_unrotated(self):
        path = make_video(Path(self.tmp) / "a.mp4", w=320, h=240)
        src = probe.probe(path)
        self.assertEqual((src["width"], src["height"]), (320, 240))
        self.assertEqual(src["rotation"], 0)
        self.assertAlmostEqual(src["fps"], 30.0, places=3)
        self.assertEqual(src["duration_ms"], 2000)
        self.assertTrue(src["has_audio"])
        self.assertEqual(src["audio_sr"], 44100)
        self.assertFalse(src["vfr"])

    def test_probe_output_passes_schema(self):
        """probe() output is the `source` block, so it must validate as one."""
        path = make_video(Path(self.tmp) / "a.mp4")
        doc_errors = schema.validate_swing({"source": probe.probe(path)})
        self.assertFalse([e for e in doc_errors if e.startswith("source")],
                         doc_errors)

    def test_display_dimensions_swap_for_quarter_turns(self):
        """A portrait iPhone .MOV probes as landscape unless dims are swapped."""
        for rotation in (90, -90, 270):
            path = make_video(Path(self.tmp) / ("r%s.mp4" % abs(rotation)),
                              w=320, h=240, rotation=rotation)
            src = probe.probe(path)
            self.assertEqual((src["width"], src["height"]), (240, 320),
                             "rotation=%s should swap display dims" % rotation)
            self.assertIn(src["rotation"], (90, 270))

    def test_rotation_is_clockwise_and_normalized(self):
        """ffprobe reports -90; we must never emit a negative or 360."""
        path = make_video(Path(self.tmp) / "neg.mp4", rotation=-90)
        self.assertEqual(probe.probe(path)["rotation"], 90)
        path = make_video(Path(self.tmp) / "pos.mp4", rotation=90)
        self.assertEqual(probe.probe(path)["rotation"], 270)

    def test_half_turn_keeps_dimensions(self):
        path = make_video(Path(self.tmp) / "h.mp4", w=320, h=240, rotation=180)
        src = probe.probe(path)
        self.assertEqual(src["rotation"], 180)
        self.assertEqual((src["width"], src["height"]), (320, 240))

    def test_coded_size_inverts_the_swap(self):
        path = make_video(Path(self.tmp) / "c.mp4", w=320, h=240, rotation=90)
        src = probe.probe(path)
        self.assertEqual(probe.coded_size(src), (320, 240))

    def test_detects_missing_audio(self):
        path = make_video(Path(self.tmp) / "silent.mp4", audio=False)
        src = probe.probe(path)
        self.assertFalse(src["has_audio"])
        self.assertIsNone(src["audio_sr"])

    def test_fingerprint_is_stable_and_distinguishing(self):
        a = make_video(Path(self.tmp) / "a.mp4", w=320, h=240)
        b = make_video(Path(self.tmp) / "b.mp4", w=160, h=120)
        self.assertEqual(probe.fingerprint(a), probe.fingerprint(a))
        self.assertNotEqual(probe.fingerprint(a), probe.fingerprint(b))

    def test_path_field_preserves_the_users_argument(self):
        path = make_video(Path(self.tmp) / "a.mp4")
        src = probe.probe(path, raw_path="~/Downloads/a.mp4")
        self.assertEqual(src["path"], "~/Downloads/a.mp4")
        self.assertEqual(src["name"], "a.mp4")

    def test_missing_file_raises(self):
        with self.assertRaises(probe.ProbeError):
            probe.probe(Path(self.tmp) / "nope.mp4")

    def test_non_video_raises(self):
        junk = Path(self.tmp) / "junk.mp4"
        junk.write_bytes(b"not a video")
        with self.assertRaises(probe.ProbeError):
            probe.probe(junk)

    def test_probe_clip_start_ms(self):
        path = make_video(Path(self.tmp) / "a.mp4")
        self.assertEqual(probe.probe_clip_start_ms(path), 0)


class TestSettings(unittest.TestCase):
    def test_defaults_validate(self):
        self.assertEqual(config.Settings().validate(), [])

    def test_round_trips_through_dict(self):
        s = config.Settings(onset_k=6.5, frame_span_s=2.0)
        self.assertEqual(config.Settings.from_dict(s.to_dict()), s)

    def test_from_dict_rejects_unknown_key(self):
        with self.assertRaises(ValueError):
            config.Settings.from_dict({"onset_k": 8.0, "bogus": 1})

    def test_from_dict_tolerates_settings_hash(self):
        """as_metadata() adds settings_hash; reading it back must work."""
        s = config.Settings()
        self.assertEqual(config.Settings.from_dict(s.as_metadata()), s)

    def test_cache_hash_changes_for_pose_affecting_knob(self):
        """Every knob that changes which frames get decoded must be in the key.

        Written against values rather than differences, so it broke the moment
        `pose_tiles` defaulted to the 3 it was asserting on -- a test that
        passes only while a constant holds still is testing the constant.
        """
        base = config.Settings()
        for field, other in (("onset_k", base.onset_k + 2.0),
                             ("pose_tiles", base.pose_tiles + 1),
                             ("pose_min_confidence", base.pose_min_confidence / 2),
                             ("scan_k", base.scan_k + 1.0),
                             ("scan_fps", base.scan_fps + 5.0),
                             ("detector", "audio")):
            changed = dataclasses.replace(base, **{field: other})
            self.assertNotEqual(base.cache_hash(), changed.cache_hash(),
                                "%s is missing from the pose cache key" % field)

    def test_cache_hash_separates_pose_backends(self):
        """Regression: a stub cache must never be reused by a real run.

        pose_backend was missing from the cache key, so `run
        --pose-backend=stub` wrote a cache of synthetic stick figures that a
        later MediaPipe run read straight back -- every crop, hitting-side
        call and measurement came from the stub, silently.
        """
        self.assertNotEqual(
            config.Settings(pose_backend="stub").cache_hash(),
            config.Settings(pose_backend="mediapipe").cache_hash())

    def test_cache_hash_stable_for_irrelevant_knobs(self):
        """A knob the pose pass never reads must not invalidate it.

        min_gap_s and min_torso are verify-stage only and used to sit in the
        key, so sweeping --gap re-ran pose for nothing.
        """
        base = config.Settings()
        for other in (config.Settings(limit=5),
                      config.Settings(clip_crf=18),
                      config.Settings(frame_quality=70),
                      config.Settings(min_gap_s=0.5),
                      config.Settings(same_place_torsos=9.0),
                      config.Settings(min_torso=0.2),
                      config.Settings(min_wrist_speed=2.0)):
            self.assertEqual(base.cache_hash(), other.cache_hash())

    def test_frames_per_swing_uses_source_fps_by_default(self):
        s = config.Settings(frame_span_s=1.6, frame_fps=0.0)
        self.assertEqual(s.frames_per_swing(30.0), 49)
        self.assertEqual(s.frames_per_swing(60.0), 97)

    def test_frames_per_swing_honours_explicit_fps(self):
        s = config.Settings(frame_span_s=1.6, frame_fps=5.0)
        self.assertEqual(s.frames_per_swing(30.0), 9)

    def test_validate_catches_bad_values(self):
        self.assertTrue(config.Settings(onset_k=0).validate())
        self.assertTrue(config.Settings(frame_quality=0).validate())
        self.assertTrue(config.Settings(player_mode="sideways").validate())
        self.assertTrue(config.Settings(pose_backend="magic").validate())
        self.assertTrue(config.Settings(crop_pad=-0.1).validate())

    def test_as_metadata_includes_hash(self):
        meta = config.Settings().as_metadata()
        self.assertIn("settings_hash", meta)
        self.assertEqual(len(meta["settings_hash"]), 16)

    def test_defaults_are_the_ones_measured_across_sessions(self):
        """The detector's two thresholds must not be tuned on one session.

        Both were, once, on 15 verdicts from a single 72-second clip, and both
        cost roughly a third of the shots in the other two sessions before
        anyone measured. `tests/test_real_footage.py` is the real guard -- this
        is the cheap one that runs without the 6GB of footage.
        """
        s = config.Settings()
        self.assertEqual(s.onset_k, 8.0)
        self.assertEqual(s.min_gap_s, 2.0)
        self.assertEqual(s.same_place_torsos, 2.0)

    def test_default_gap_sits_in_the_measured_gap_between_the_populations(self):
        """min_gap_s must separate two measured populations, not split one.

        Above it, the fastest a player was ever seen hitting twice: 2.53s,
        over 171 A-B-A triples in out/ where an opponent's shot sits between
        two shots by the same player, so both are certainly real. Below it,
        the duplicates: over the 76 adjacent pairs that claim one ball-machine
        feed slot twice in the 16 sessions periodic enough to fit a lattice,
        the median gap is 1.30s and the 90th percentile 1.53s.

        A default outside 1.53..2.53 is not a threshold between them any more
        -- below, it leaves most of the duplicates it could see; above, it
        starts deleting shots a player really hit. `Settings.min_gap_s`
        carries the workings, including why the default sits at the far end of
        that band rather than the middle: past 2.0s the removals stop being
        feed-slot collisions and become ordinary shots.
        """
        self.assertGreaterEqual(config.Settings().min_gap_s, 1.53)
        self.assertLess(config.Settings().min_gap_s, 2.53)

    def test_same_place_default_clears_every_measured_two_player_pair(self):
        """The court-position guard must not merge two people.

        Of the 597 adjacent pairs under 2.5s apart in out/, the 84 that cross
        a player_slot boundary separate by at least 2.12 torso heights, and
        the same-player pairs sit at a median of 0.53. A default at or above
        2.12 would start collapsing real exchanges; one much below 1.0 would
        stop catching the same player between two frames of drift.
        """
        self.assertLess(config.Settings().same_place_torsos, 2.12)
        self.assertGreaterEqual(config.Settings().same_place_torsos, 1.0)


if __name__ == "__main__":
    unittest.main()
