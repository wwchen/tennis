"""Tests for clip cutting and frame extraction, against real ffmpeg output."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import config, probe, render, schema

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def make_video(path, w=640, h=480, duration=6, fps=30, rotation=None):
    """A video whose content changes over time.

    `testsrc` alone is nearly static in any given crop window, so a test
    asserting that two stills differ would pass or fail on codec noise.
    Overlaying a moving box makes the frames genuinely distinct.
    """
    moving = ("testsrc=size=%dx%d:rate=%d:duration=%d[bg];"
              "color=c=white:size=40x40:duration=%d[box];"
              "[bg][box]overlay=x='(W-40)*t/%d':y='(H-40)*t/%d'"
              % (w, h, fps, duration, duration, duration, duration))
    subprocess.run(
        ["ffmpeg", "-v", "error",
         "-filter_complex", moving,
         "-f", "lavfi", "-i", "sine=frequency=440:duration=%d" % duration,
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-t", str(duration), "-y", str(path)],
        check=True, capture_output=True)
    if rotation is None:
        return path
    out = Path(str(path).replace(".mp4", "_rot.mp4"))
    subprocess.run(["ffmpeg", "-v", "error", "-display_rotation", str(rotation),
                    "-i", str(path), "-c", "copy", "-y", str(out)],
                   check=True, capture_output=True)
    return out


class TestClipBounds(unittest.TestCase):
    def test_centres_on_contact(self):
        self.assertEqual(render.clip_bounds(10000, 1.5, 2.0, 60000),
                         (8500, 12000))

    def test_clamps_at_the_start(self):
        start, end = render.clip_bounds(500, 1.5, 2.0, 60000)
        self.assertEqual(start, 0)
        self.assertEqual(end, 2500)

    def test_clamps_at_the_end(self):
        start, end = render.clip_bounds(59500, 1.5, 2.0, 60000)
        self.assertEqual(start, 58000)
        self.assertEqual(end, 60000)

    def test_never_inverts(self):
        start, end = render.clip_bounds(60000, 1.5, 2.0, 60000)
        self.assertLess(start, end)


class TestFrameTimes(unittest.TestCase):
    def test_contact_is_always_on_the_grid(self):
        """The frame a human will call contact must exist to be labelled."""
        times = render.frame_times_ms(10000, 1.6, 30.0, 60000)
        self.assertIn(10000, times)

    def test_span_and_fps_set_the_count(self):
        times = render.frame_times_ms(10000, 1.6, 30.0, 60000)
        self.assertEqual(len(times), 49)
        times = render.frame_times_ms(10000, 1.6, 60.0, 60000)
        self.assertEqual(len(times), 97)

    def test_spacing_matches_fps(self):
        times = render.frame_times_ms(10000, 1.6, 30.0, 60000)
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertTrue(all(32 <= g <= 34 for g in gaps), gaps)

    def test_sorted_and_unique(self):
        times = render.frame_times_ms(10000, 1.6, 30.0, 60000)
        self.assertEqual(times, sorted(times))
        self.assertEqual(len(times), len(set(times)))

    def test_truncates_at_video_start(self):
        times = render.frame_times_ms(200, 1.6, 30.0, 60000)
        self.assertTrue(all(t >= 0 for t in times))
        self.assertIn(200, times)

    def test_truncates_at_video_end(self):
        times = render.frame_times_ms(59900, 1.6, 30.0, 60000)
        self.assertTrue(all(t <= 60000 for t in times))

    def test_zero_fps_yields_contact_only(self):
        self.assertEqual(render.frame_times_ms(5000, 1.6, 0.0, 60000), [5000])

    def test_sparse_fps_still_includes_contact(self):
        times = render.frame_times_ms(10000, 2.4, 5.0, 60000)
        self.assertIn(10000, times)
        self.assertEqual(len(times), 13)


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestCutClip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.video = make_video(Path(self.tmp) / "src.mp4", 640, 480,
                                duration=6)
        self.source = probe.probe(self.video)
        self.rect = {"x": 100, "y": 80, "w": 320, "h": 240,
                     "space": "source_display", "static": True}

    def test_writes_a_playable_clip(self):
        dest = Path(self.tmp) / "clip.mp4"
        trim = render.cut_clip(self.video, dest, self.rect, 2000, 4000)
        self.assertTrue(dest.exists())
        self.assertGreater(dest.stat().st_size, 1000)
        self.assertEqual(trim["file"], "clip.mp4")
        self.assertEqual(trim["source_start_ms"], 2000)
        self.assertEqual(trim["source_end_ms"], 4000)

    def test_trim_block_validates(self):
        trim = render.cut_clip(self.video, Path(self.tmp) / "c.mp4",
                               self.rect, 2000, 4000)
        errors = schema.validate_swing({"trim": trim})
        self.assertFalse([e for e in errors if e.startswith("trim")], errors)

    def test_duration_matches_the_request(self):
        dest = Path(self.tmp) / "clip.mp4"
        render.cut_clip(self.video, dest, self.rect, 2000, 4000)
        self.assertAlmostEqual(probe.probe(dest)["duration_ms"], 2000, delta=150)

    def test_encoded_start_is_accurate_for_a_reencode(self):
        """A stream copy would snap to a keyframe; a re-encode must not."""
        trim = render.cut_clip(self.video, Path(self.tmp) / "c.mp4",
                               self.rect, 2500, 4000)
        self.assertAlmostEqual(trim["encoded_start_ms"], 2500, delta=60)

    def test_crop_is_applied(self):
        """Output aspect must follow the crop rect, not the source."""
        dest = Path(self.tmp) / "clip.mp4"
        trim = render.cut_clip(self.video, dest, self.rect, 2000, 3000,
                               height=240)
        self.assertEqual(trim["height"], 240)
        self.assertAlmostEqual(trim["width"] / trim["height"],
                               self.rect["w"] / self.rect["h"], delta=0.05)

    def test_dimensions_are_even(self):
        rect = {"x": 0, "y": 0, "w": 322, "h": 242,
                "space": "source_display", "static": True}
        trim = render.cut_clip(self.video, Path(self.tmp) / "c.mp4", rect,
                               1000, 2000, height=0)
        self.assertEqual(trim["width"] % 2, 0)
        self.assertEqual(trim["height"] % 2, 0)

    def test_never_upscales_a_small_crop(self):
        """Blowing up a small crop spends bytes without adding detail."""
        small = {"x": 0, "y": 0, "w": 200, "h": 150,
                 "space": "source_display", "static": True}
        trim = render.cut_clip(self.video, Path(self.tmp) / "small.mp4",
                               small, 1000, 2000, height=480)
        self.assertLessEqual(trim["height"], 150)
        self.assertLessEqual(trim["width"], 200)

    def test_downscales_a_large_crop(self):
        large = {"x": 0, "y": 0, "w": 640, "h": 480,
                 "space": "source_display", "static": True}
        trim = render.cut_clip(self.video, Path(self.tmp) / "large.mp4",
                               large, 1000, 2000, height=240)
        self.assertEqual(trim["height"], 240)

    def test_bad_input_raises(self):
        with self.assertRaises((render.RenderError, Exception)):
            render.cut_clip(Path(self.tmp) / "nope.mp4",
                            Path(self.tmp) / "c.mp4", self.rect, 0, 1000)


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestExtractFrames(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.video = make_video(Path(self.tmp) / "src.mp4", 640, 480,
                                duration=6)
        self.rect = {"x": 100, "y": 80, "w": 320, "h": 240,
                     "space": "source_display", "static": True}

    def test_writes_one_file_per_timestamp(self):
        times = [1000, 1033, 1067, 1100]
        got = render.extract_frames(self.video, Path(self.tmp) / "frames",
                                    self.rect, times)
        self.assertEqual(len(got), 4)
        for index, name, source_ms in got:
            self.assertTrue((Path(self.tmp) / "frames" / name).exists())

    def test_names_are_four_digit_indices(self):
        """Two digits would mis-sort at --fps 60 over a wide span."""
        got = render.extract_frames(self.video, Path(self.tmp) / "f",
                                    self.rect, [1000, 1033])
        self.assertEqual(got[0][1], "frame_0000.jpg")
        self.assertEqual(got[1][1], "frame_0001.jpg")

    def test_names_sort_in_time_order(self):
        times = [1000 + 33 * i for i in range(120)]
        got = render.extract_frames(self.video, Path(self.tmp) / "f",
                                    self.rect, times)
        names = [n for _, n, _ in got]
        self.assertEqual(names, sorted(names),
                         "filenames must sort chronologically")

    def test_frames_are_cropped_and_scaled(self):
        got = render.extract_frames(self.video, Path(self.tmp) / "f",
                                    self.rect, [2000], long_edge=160)
        img = cv2.imread(str(Path(self.tmp) / "f" / got[0][1]))
        self.assertEqual(max(img.shape[:2]), 160)
        self.assertAlmostEqual(img.shape[1] / img.shape[0],
                               self.rect["w"] / self.rect["h"], delta=0.05)

    def test_frames_differ_from_each_other(self):
        """A moving source must yield distinct stills, not the same frame."""
        got = render.extract_frames(self.video, Path(self.tmp) / "f",
                                    self.rect, [1000, 3000, 5000])
        images = [cv2.imread(str(Path(self.tmp) / "f" / n)) for _, n, _ in got]
        self.assertFalse((images[0] == images[1]).all())
        self.assertFalse((images[1] == images[2]).all())

    def test_quality_affects_size(self):
        low = render.extract_frames(self.video, Path(self.tmp) / "lo",
                                    self.rect, [2000], quality=40)
        high = render.extract_frames(self.video, Path(self.tmp) / "hi",
                                     self.rect, [2000], quality=95)
        lo_size = (Path(self.tmp) / "lo" / low[0][1]).stat().st_size
        hi_size = (Path(self.tmp) / "hi" / high[0][1]).stat().st_size
        self.assertLess(lo_size, hi_size)

    def test_creates_the_directory(self):
        target = Path(self.tmp) / "deep" / "frames"
        render.extract_frames(self.video, target, self.rect, [1000])
        self.assertTrue(target.is_dir())


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestRenderSwing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.video = make_video(Path(self.tmp) / "src.mp4", 640, 480,
                                duration=8)
        self.source = probe.probe(self.video)
        self.rect = {"x": 100, "y": 80, "w": 320, "h": 240,
                     "space": "source_display", "static": True}
        self.settings = config.Settings(frame_span_s=0.4, frame_long_edge=160,
                                        clip_height=240)

    def render(self, contact_ms=4000, dest="swing_001"):
        return render.render_swing(self.video, Path(self.tmp) / dest,
                                   self.rect, contact_ms, self.source,
                                   self.settings)

    def test_produces_clip_and_frames(self):
        trim, frames = self.render()
        dest = Path(self.tmp) / "swing_001"
        self.assertTrue((dest / "clip.mp4").exists())
        self.assertTrue(frames)
        for frame in frames:
            self.assertTrue((dest / frame["file"]).exists())

    def test_frame_records_validate_in_a_swing_doc(self):
        _, frames = self.render()
        errors = schema.validate_swing({"frames": frames,
                                        "measurements": None})
        self.assertFalse([e for e in errors if e.startswith("frames")], errors)

    def test_source_ms_increases_strictly(self):
        """overlay() joins on source_ms, so duplicates would be ambiguous."""
        _, frames = self.render()
        times = [f["source_ms"] for f in frames]
        self.assertEqual(times, sorted(times))
        self.assertEqual(len(times), len(set(times)))

    def test_exactly_one_frame_sits_at_contact(self):
        _, frames = self.render(contact_ms=4000)
        at_contact = [f for f in frames if f["offset_contact_ms"] == 0]
        self.assertEqual(len(at_contact), 1)
        self.assertEqual(at_contact[0]["source_ms"], 4000)

    def test_offsets_are_measured_from_contact(self):
        _, frames = self.render(contact_ms=4000)
        for frame in frames:
            self.assertEqual(frame["offset_contact_ms"],
                             frame["source_ms"] - 4000)

    def test_clip_ms_is_relative_to_the_clip(self):
        trim, frames = self.render(contact_ms=4000)
        for frame in frames:
            self.assertEqual(frame["clip_ms"],
                             frame["source_ms"] - trim["source_start_ms"])
            self.assertGreaterEqual(frame["clip_ms"], 0)

    def test_labels_ship_null_for_a_human_to_fill(self):
        _, frames = self.render()
        self.assertTrue(all(f["stage"] is None for f in frames))

    def test_frame_count_matches_the_settings(self):
        _, frames = self.render()
        expected = self.settings.frames_per_swing(self.source["fps"])
        self.assertAlmostEqual(len(frames), expected, delta=1)

    def test_works_near_the_video_start(self):
        trim, frames = self.render(contact_ms=100, dest="edge_a")
        self.assertTrue(frames)
        self.assertEqual(trim["source_start_ms"], 0)

    def test_works_near_the_video_end(self):
        trim, frames = self.render(contact_ms=self.source["duration_ms"] - 100,
                                   dest="edge_b")
        self.assertTrue(frames)
        self.assertLessEqual(trim["source_end_ms"], self.source["duration_ms"])

    def test_portrait_source_renders(self):
        """The iPhone case, end to end through render."""
        video = make_video(Path(self.tmp) / "p.mp4", 640, 480, duration=6,
                           rotation=90)
        source = probe.probe(video)
        rect = {"x": 40, "y": 100, "w": 240, "h": 320,
                "space": "source_display", "static": True}
        trim, frames = render.render_swing(video, Path(self.tmp) / "portrait",
                                           rect, 3000, source, self.settings)
        self.assertTrue(frames)
        img = cv2.imread(str(Path(self.tmp) / "portrait" / frames[0]["file"]))
        self.assertGreater(img.shape[0], img.shape[1],
                           "a portrait crop must yield a portrait still")


if __name__ == "__main__":
    unittest.main()
