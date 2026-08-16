"""Tests for track extraction, rotation normalization, and the pose cache."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import pose, probe, tracks

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def make_video(path, w=320, h=240, rotation=None, duration=4, fps=30):
    cmd = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
           "testsrc=size=%dx%d:rate=%d:duration=%d" % (w, h, fps, duration),
           "-f", "lavfi", "-i", "sine=frequency=440:duration=%d" % duration,
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
           "-y", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    if rotation is None:
        return path
    out = Path(str(path).replace(".mp4", "_rot.mp4"))
    subprocess.run(["ffmpeg", "-v", "error", "-display_rotation", str(rotation),
                    "-i", str(path), "-c", "copy", "-y", str(out)],
                   check=True, capture_output=True)
    return out


def make_track(n=9, base_ms=106834, step_ms=33, players=1, gaps=()):
    """A synthetic Track without touching a video file."""
    frames = []
    backend = pose.StubBackend(players=players)
    dummy = np.zeros((240, 320, 3), np.uint8)
    for i in range(n):
        ms = base_ms + i * step_ms
        poses = [] if i in gaps else backend.detect(dummy, ms)
        frames.append({"source_ms": ms, "poses": poses})
    return tracks.Track({"contact_ms": base_ms + (n // 2) * step_ms,
                         "onset_peak": 12.0}, frames, (320, 240))


class TestRotateFrame(unittest.TestCase):
    def test_zero_is_identity(self):
        frame = np.random.randint(0, 255, (10, 20, 3), dtype=np.uint8)
        np.testing.assert_array_equal(tracks.rotate_frame(frame, 0, cv2), frame)

    def test_quarter_turns_swap_dimensions(self):
        frame = np.zeros((10, 20, 3), np.uint8)
        for rotation in (90, 270):
            got = tracks.rotate_frame(frame, rotation, cv2)
            self.assertEqual(got.shape[:2], (20, 10))

    def test_half_turn_keeps_dimensions(self):
        frame = np.zeros((10, 20, 3), np.uint8)
        self.assertEqual(tracks.rotate_frame(frame, 180, cv2).shape[:2], (10, 20))

    def test_four_quarter_turns_return_to_start(self):
        frame = np.random.randint(0, 255, (8, 12, 3), dtype=np.uint8)
        got = frame
        for _ in range(4):
            got = tracks.rotate_frame(got, 90, cv2)
        np.testing.assert_array_equal(got, frame)

    def test_direction_is_clockwise(self):
        """A marker in the top-left must land top-right after 90 clockwise."""
        frame = np.zeros((10, 10, 3), np.uint8)
        frame[0, 0] = 255
        got = tracks.rotate_frame(frame, 90, cv2)
        self.assertEqual(got[0, -1, 0], 255)
        self.assertEqual(got[0, 0, 0], 0)


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestRotationMatchesFfmpeg(unittest.TestCase):
    """The core invariant: our decode agrees with ffmpeg's.

    ffmpeg applies the display matrix when it extracts a frame. If our decode
    disagreed, pose coordinates and the crop rect ffmpeg later applies would
    be in different spaces -- a 90-degree error on every portrait video.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def ffmpeg_first_frame(self, video):
        out = Path(self.tmp) / "gt.png"
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(video),
                        "-frames:v", "1", "-y", str(out)],
                       check=True, capture_output=True)
        return cv2.imread(str(out))

    def our_first_frame(self, video, source):
        cap = tracks.open_capture(video, cv2)
        try:
            ok, raw = cap.read()
            self.assertTrue(ok)
        finally:
            cap.release()
        return tracks.rotate_frame(raw, source["rotation"], cv2)

    def assert_agrees(self, video):
        source = probe.probe(video)
        ours = self.our_first_frame(video, source)
        theirs = self.ffmpeg_first_frame(video)
        self.assertEqual(ours.shape, theirs.shape,
                         "decoded orientation disagrees with ffmpeg")
        diff = float(np.abs(ours.astype(int) - theirs.astype(int)).mean())
        self.assertLess(diff, 10.0,
                        "frames differ by %.1f -- likely a rotation error" % diff)
        self.assertEqual((ours.shape[1], ours.shape[0]),
                         (source["width"], source["height"]),
                         "decoded size disagrees with probed display size")

    def test_agrees_unrotated(self):
        self.assert_agrees(make_video(Path(self.tmp) / "a.mp4"))

    def test_agrees_for_every_rotation(self):
        for rotation in (90, -90, 180):
            video = make_video(Path(self.tmp) / ("r%d.mp4" % abs(rotation)),
                               rotation=rotation)
            with self.subTest(rotation=rotation):
                self.assert_agrees(video)

    def test_portrait_source_decodes_portrait(self):
        """The iPhone case: a 90-rotated landscape file is portrait on screen."""
        video = make_video(Path(self.tmp) / "p.mp4", w=320, h=240, rotation=90)
        source = probe.probe(video)
        frame = self.our_first_frame(video, source)
        self.assertGreater(frame.shape[0], frame.shape[1],
                           "expected a portrait frame")


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestExtractTrack(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.video = make_video(Path(self.tmp) / "a.mp4", duration=4)
        self.source = probe.probe(self.video)

    def extract(self, contact_ms=2000, window_s=0.2, players=1):
        with pose.StubBackend(players=players) as backend:
            return tracks.extract_track(
                self.video, {"contact_ms": contact_ms, "onset_peak": 10.0},
                self.source, backend, window_s=window_s)

    def test_window_is_centred_on_contact(self):
        track = self.extract(contact_ms=2000, window_s=0.2)
        times = [f["source_ms"] for f in track.frames]
        self.assertTrue(times)
        self.assertGreaterEqual(min(times), 1800 - 40)
        self.assertLessEqual(max(times), 2200 + 40)

    def test_frame_count_matches_window_and_fps(self):
        track = self.extract(window_s=0.2)
        # 0.4s of 30fps video is ~12 frames, allowing for seek granularity.
        self.assertGreaterEqual(len(track.frames), 9)
        self.assertLessEqual(len(track.frames), 15)

    def test_timestamps_increase(self):
        times = [f["source_ms"] for f in self.extract().frames]
        self.assertEqual(times, sorted(times))

    def test_every_frame_gets_a_pose_from_the_stub(self):
        track = self.extract()
        self.assertEqual(track.detected_count(), len(track.frames))

    def test_frame_size_is_display_size(self):
        track = self.extract()
        self.assertEqual(track.frame_size,
                         (self.source["width"], self.source["height"]))

    def test_two_players_yield_two_slots(self):
        self.assertEqual(self.extract(players=2).slot_count(), 2)

    def test_window_clamps_at_video_start(self):
        track = self.extract(contact_ms=50, window_s=0.4)
        self.assertTrue(track.frames)
        self.assertGreaterEqual(min(f["source_ms"] for f in track.frames), 0)

    def test_window_clamps_at_video_end(self):
        track = self.extract(contact_ms=self.source["duration_ms"] - 50,
                             window_s=0.4)
        self.assertTrue(track.frames)

    def test_rotated_source_extracts_rotated_frames(self):
        video = make_video(Path(self.tmp) / "r.mp4", w=320, h=240, rotation=90)
        source = probe.probe(video)
        with pose.StubBackend() as backend:
            track = tracks.extract_track(
                video, {"contact_ms": 2000, "onset_peak": 9.0}, source,
                backend, window_s=0.1)
        self.assertEqual(track.frame_size, (source["width"], source["height"]))
        self.assertGreater(track.frame_size[1], track.frame_size[0])


class TestTrackQueries(unittest.TestCase):
    def test_series_skips_frames_without_detections(self):
        track = make_track(n=9, gaps=(2, 5))
        self.assertEqual(len(track.series(0)), 7)
        self.assertEqual(track.detected_count(), 7)

    def test_series_for_an_absent_slot_is_empty(self):
        self.assertEqual(make_track(players=1).series(1), [])

    def test_nearest_index_finds_the_closest_frame(self):
        track = make_track(n=9, base_ms=1000, step_ms=100)
        rows = track.series(0)
        idx = track.nearest_index(1420)
        self.assertEqual(rows[idx][0], 1400)

    def test_nearest_index_at_the_edges(self):
        track = make_track(n=5, base_ms=1000, step_ms=100)
        self.assertEqual(track.nearest_index(0), 0)
        self.assertEqual(track.nearest_index(999999), 4)

    def test_nearest_index_is_none_without_detections(self):
        track = make_track(n=3, gaps=(0, 1, 2))
        self.assertIsNone(track.nearest_index(1000))

    def test_contact_ms_comes_from_the_candidate(self):
        self.assertEqual(make_track(n=9, base_ms=1000, step_ms=100).contact_ms,
                         1400)


class TestCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = Path(self.tmp) / "pose.jsonl.gz"

    def test_round_trip(self):
        original = [make_track(n=5), make_track(n=5, base_ms=200000)]
        tracks.write_cache(self.path, original, "hash1")
        back = tracks.read_cache(self.path, "hash1")
        self.assertEqual(len(back), 2)
        self.assertEqual(back[0].contact_ms, original[0].contact_ms)
        self.assertEqual(len(back[0].frames), 5)
        self.assertEqual(back[0].frame_size, (320, 240))

    def test_landmarks_survive_the_round_trip(self):
        original = make_track(n=3)
        tracks.write_cache(self.path, original and [original], "h")
        back = tracks.read_cache(self.path, "h")[0]
        before = original.series(0)[0][1]
        after = back.series(0)[0][1]
        self.assertAlmostEqual(after.center_x(), before.center_x(), places=4)
        self.assertAlmostEqual(after.torso_height(), before.torso_height(),
                               places=4)
        self.assertAlmostEqual(after.xy(pose.R_WRIST)[0],
                               before.xy(pose.R_WRIST)[0], places=4)

    def test_settings_change_invalidates(self):
        """Re-tuning a pose knob must not silently reuse stale work."""
        tracks.write_cache(self.path, [make_track(n=3)], "hash1")
        self.assertIsNone(tracks.read_cache(self.path, "hash2"))
        self.assertIsNotNone(tracks.read_cache(self.path, "hash1"))

    def test_missing_file_returns_none(self):
        self.assertIsNone(tracks.read_cache(Path(self.tmp) / "nope.gz", "h"))

    def test_corrupt_file_returns_none_rather_than_raising(self):
        self.path.write_bytes(b"not gzip")
        self.assertIsNone(tracks.read_cache(self.path, "h"))

    def test_empty_track_list_round_trips(self):
        tracks.write_cache(self.path, [], "h")
        self.assertEqual(tracks.read_cache(self.path, "h"), [])

    def test_gaps_survive_the_round_trip(self):
        tracks.write_cache(self.path, [make_track(n=6, gaps=(1, 3))], "h")
        back = tracks.read_cache(self.path, "h")[0]
        self.assertEqual(back.detected_count(), 4)


if __name__ == "__main__":
    unittest.main()
