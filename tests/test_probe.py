"""Tests for probe.py and config.py, against real ffmpeg-written files."""

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
        base = config.Settings()
        self.assertNotEqual(base.cache_hash(),
                            config.Settings(onset_k=6.0).cache_hash())
        self.assertNotEqual(base.cache_hash(),
                            config.Settings(pose_tiles=3).cache_hash())

    def test_cache_hash_stable_for_irrelevant_knobs(self):
        """Changing --jobs must not throw away a valid pose pass."""
        base = config.Settings()
        for other in (config.Settings(jobs=16), config.Settings(limit=5),
                      config.Settings(clip_crf=18),
                      config.Settings(frame_quality=70)):
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

    def test_default_gap_does_not_swallow_real_rallies(self):
        """min_gap_s must not discard genuinely fast exchanges.

        Measured over 351 pose-verified shots in three real sessions: the
        closest real pair is 0.12s apart, the 10th percentile is 0.14s, and
        thresholds cost 15% of shots at 0.15s, 38% at 0.35s and 60%+ at the
        3.5s this project originally used. Recall against those sessions is
        99-100% at 0.12s and drops to 75% at 0.35s.
        """
        self.assertLessEqual(config.Settings().min_gap_s, 0.13)


if __name__ == "__main__":
    unittest.main()
