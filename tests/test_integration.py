"""End-to-end ETL tests against a synthesized video.

A real session video is not available in this repository (the sources the
earlier output was built from are gone), so the fixture is built with ffmpeg:
a moving box for pose to find and sharp clicks at known times for the
detector to find. With --pose-backend=stub the whole pipeline runs headless,
where MediaPipe would abort.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import cli, config, pipeline, schema, session

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

CLICK_TIMES = (2.0, 5.0, 8.0)


def write_clicks(path, times_s, duration_s, sr=22050):
    rng = np.random.default_rng(0)
    x = rng.normal(0.0, 0.004, int(duration_s * sr)).astype(np.float32)
    span = int(0.004 * sr)
    env = np.exp(-np.linspace(0.0, 6.0, span)).astype(np.float32)
    for t in times_s:
        start = int(t * sr)
        burst = rng.normal(0.0, 1.0, span).astype(np.float32) * env * 0.9
        x[start:start + span] += burst[:max(0, min(span, x.size - start))]
    x = np.clip(x, -1.0, 1.0)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((x * 32767).astype("<i2").tobytes())
    return path


def make_session_video(tmp, w=640, h=480, duration=10, rotation=None):
    """A moving box plus clicks at CLICK_TIMES."""
    wav = write_clicks(Path(tmp) / "audio.wav", CLICK_TIMES, duration)
    moving = ("testsrc=size=%dx%d:rate=30:duration=%d[bg];"
              "color=c=white:size=60x60:duration=%d[box];"
              "[bg][box]overlay=x='(W-60)*t/%d':y='(H-60)*0.5'"
              % (w, h, duration, duration, duration))
    out = Path(tmp) / "session.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-filter_complex", moving,
         "-i", str(wav), "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-t", str(duration), "-y", str(out)],
        check=True, capture_output=True)
    if rotation is None:
        return out
    rotated = Path(tmp) / "session_rot.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-display_rotation",
                    str(rotation), "-i", str(out), "-c", "copy", "-y",
                    str(rotated)], check=True, capture_output=True)
    return rotated


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.video = make_session_video(cls.tmp, duration=10)
        cls.outdir = Path(cls.tmp) / "out"
        cls.settings = config.Settings(
            pose_backend="stub", frame_span_s=0.4, frame_long_edge=160,
            clip_height=240, pre_s=0.5, post_s=0.5)
        cls.doc = pipeline.run(cls.video, cls.outdir, cls.settings)
        cls.root = session.out_root(cls.outdir, cls.video)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # --- the output tree ------------------------------------------------
    def test_writes_the_expected_tree(self):
        self.assertTrue(os.path.exists(os.path.join(self.root,
                                                    "metadata.json")))
        self.assertTrue(os.path.isdir(os.path.join(self.root, "swings")))
        self.assertTrue(os.path.isdir(os.path.join(self.root, "work")))

    def test_finds_the_planted_shots(self):
        times = [ref["contact_ms"] / 1000.0 for ref in self.doc["swings"]]
        self.assertEqual(len(times), len(CLICK_TIMES),
                         "expected %s, got %s" % (list(CLICK_TIMES), times))
        for got, want in zip(times, CLICK_TIMES):
            self.assertLess(abs(got - want), 0.1,
                            "%s is not near %s" % (times, list(CLICK_TIMES)))

    def test_every_swing_has_clip_frames_and_metadata(self):
        for ref in self.doc["swings"]:
            swing_dir = os.path.join(self.root, ref["dir"])
            self.assertTrue(os.path.exists(os.path.join(swing_dir,
                                                        "clip.mp4")))
            self.assertTrue(os.path.exists(os.path.join(swing_dir,
                                                        "metadata.json")))
            self.assertTrue(os.path.exists(os.path.join(swing_dir,
                                                        "pose.json")))
            frames = os.listdir(os.path.join(swing_dir, "frames"))
            self.assertGreater(len(frames), 5)

    def test_swing_dirs_are_numbered_in_time_order(self):
        dirs = [ref["dir"] for ref in self.doc["swings"]]
        self.assertEqual(dirs, sorted(dirs))
        times = [ref["contact_ms"] for ref in self.doc["swings"]]
        self.assertEqual(times, sorted(times))

    # --- validity ------------------------------------------------------
    def test_whole_tree_validates(self):
        checked, problems = session.validate_tree(self.root)
        self.assertGreater(checked, 1)
        self.assertEqual(problems, [], problems[:2])

    def test_session_doc_validates(self):
        self.assertEqual(schema.validate_session(self.doc), [])

    def test_every_referenced_file_exists(self):
        for ref in self.doc["swings"]:
            swing_dir = os.path.join(self.root, ref["dir"])
            doc = session.read_json(os.path.join(swing_dir, "metadata.json"))
            for frame in doc["frames"]:
                self.assertTrue(
                    os.path.exists(os.path.join(swing_dir, frame["file"])),
                    "missing %s" % frame["file"])

    # --- the labelling contract ----------------------------------------
    def test_label_fields_ship_null_for_a_human(self):
        """Classification is out of scope: the fields exist, empty."""
        for ref in self.doc["swings"]:
            doc = session.read_json(os.path.join(self.root, ref["dir"],
                                                 "metadata.json"))
            self.assertIsNone(doc["labels"]["stroke"])
            self.assertIsNone(doc["labels"]["quality"])
            self.assertIsNone(doc["labels"]["verdict"])
            self.assertIsNone(doc["labels"]["player_name"])
            self.assertEqual(doc["labels"]["tags"], [])
            self.assertTrue(all(f["stage"] is None for f in doc["frames"]))

    def test_player_slot_is_filled_by_the_pipeline(self):
        for ref in self.doc["swings"]:
            self.assertIn(ref["player_slot"], schema.PLAYER_SLOTS)

    def test_exactly_one_frame_per_swing_sits_at_contact(self):
        for ref in self.doc["swings"]:
            doc = session.read_json(os.path.join(self.root, ref["dir"],
                                                 "metadata.json"))
            at = [f for f in doc["frames"] if f["offset_contact_ms"] == 0]
            self.assertEqual(len(at), 1, ref["dir"])

    def test_frames_have_measurements_and_pose_scores(self):
        doc = session.read_json(os.path.join(self.root,
                                             self.doc["swings"][0]["dir"],
                                             "metadata.json"))
        self.assertIsNotNone(doc["measurements"])
        self.assertIn(doc["measurements"]["hitting_side"],
                      schema.HITTING_SIDES)
        self.assertTrue(any(f["pose_score"] is not None
                            for f in doc["frames"]))

    def test_source_is_denormalized_into_every_swing(self):
        """A swing dir must stand alone once shipped elsewhere."""
        for ref in self.doc["swings"]:
            doc = session.read_json(os.path.join(self.root, ref["dir"],
                                                 "metadata.json"))
            self.assertEqual(doc["source"]["name"], self.doc["source"]["name"])
            self.assertEqual(doc["source"]["sha256_16"],
                             self.doc["source"]["sha256_16"])

    def test_detection_histogram_accounts_for_every_candidate(self):
        detection = self.doc["detection"]
        self.assertEqual(detection["verified"], len(self.doc["swings"]))
        self.assertEqual(sum(detection["reject_histogram"].values()),
                         detection["rejected"])

    # --- the human edit round trip -------------------------------------
    def test_user_edit_round_trips_through_overlay(self):
        swing_dir = os.path.join(self.root, self.doc["swings"][0]["dir"])
        metadata = session.read_json(os.path.join(swing_dir, "metadata.json"))
        contact = [f for f in metadata["frames"]
                   if f["offset_contact_ms"] == 0][0]
        later = [f for f in metadata["frames"]
                 if f["source_ms"] > contact["source_ms"]][0]

        edit = json.loads(json.dumps(metadata))
        edit["labels"].update({"player_name": "me", "stroke": "backhand",
                               "quality": 4, "verdict": "valid",
                               "tags": ["late contact"], "notes": "netted"})
        for frame in edit["frames"]:
            if frame["source_ms"] == later["source_ms"]:
                frame["stage"] = "contact"
        edit["edit"] = {"by": "wc", "at": "2026-08-16T10:12:04Z",
                        "against": schema.doc_hash(metadata),
                        "reviewed": True}
        self.assertEqual(schema.validate_swing(edit), [])
        session.write_json(os.path.join(swing_dir, "user-edit.json"), edit)

        merged, warnings = session.load_swing(swing_dir)
        self.assertEqual(warnings, [])
        self.assertEqual(merged["labels"]["stroke"], "backhand")
        self.assertEqual(merged["labels"]["player_name"], "me")
        self.assertEqual(merged["labels"]["quality"], 4)
        by_ms = {f["source_ms"]: f["stage"] for f in merged["frames"]}
        self.assertEqual(by_ms[later["source_ms"]], "contact")
        # The detector's own record is untouched by the edit.
        self.assertEqual(merged["detection"]["contact_ms"],
                         metadata["detection"]["contact_ms"])
        os.unlink(os.path.join(swing_dir, "user-edit.json"))

    def test_stale_edit_is_flagged(self):
        swing_dir = os.path.join(self.root, self.doc["swings"][0]["dir"])
        metadata = session.read_json(os.path.join(swing_dir, "metadata.json"))
        edit = json.loads(json.dumps(metadata))
        edit["labels"]["stroke"] = "forehand"
        edit["edit"] = {"by": "wc", "at": "2026-08-16T10:12:04Z",
                        "against": "sha256:something-else", "reviewed": True}
        session.write_json(os.path.join(swing_dir, "user-edit.json"), edit)
        merged, warnings = session.load_swing(swing_dir)
        self.assertTrue(any("stale" in w.lower() for w in warnings), warnings)
        self.assertEqual(merged["labels"]["stroke"], "forehand")
        os.unlink(os.path.join(swing_dir, "user-edit.json"))

    # --- caching -------------------------------------------------------
    def test_pose_cache_is_written(self):
        self.assertTrue(os.path.exists(os.path.join(self.root, "work",
                                                    "pose.jsonl.gz")))

    def test_rerun_reuses_the_pose_cache(self):
        """Re-running must not re-run pose. Proven by counting detect calls."""
        from tennisproc import pose as pose_mod
        original = pose_mod.StubBackend.detect
        calls = {"n": 0}

        def counting(self, frame, timestamp_ms=None):
            calls["n"] += 1
            return original(self, frame, timestamp_ms)

        pose_mod.StubBackend.detect = counting
        try:
            pipeline.run(self.video, self.outdir, self.settings)
        finally:
            pose_mod.StubBackend.detect = original
        self.assertEqual(calls["n"], 0,
                         "pose ran again despite a valid cache")

    def test_changing_a_pose_setting_invalidates_the_cache(self):
        from tennisproc import pose as pose_mod
        original = pose_mod.StubBackend.detect
        calls = {"n": 0}

        def counting(self, frame, timestamp_ms=None):
            calls["n"] += 1
            return original(self, frame, timestamp_ms)

        changed = config.Settings(**dict(self.settings.to_dict(),
                                         onset_k=7.0))
        pose_mod.StubBackend.detect = counting
        try:
            pipeline.run(self.video, Path(self.tmp) / "out2", changed)
        finally:
            pose_mod.StubBackend.detect = original
        self.assertGreater(calls["n"], 0,
                           "cache was reused after a settings change")


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestPortraitEndToEnd(unittest.TestCase):
    """The iPhone case: a rotated source, all the way through."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_portrait_session_processes(self):
        video = make_session_video(self.tmp, w=640, h=480, duration=10,
                                   rotation=90)
        settings = config.Settings(pose_backend="stub", frame_span_s=0.3,
                                  frame_long_edge=160, clip_height=240,
                                  pre_s=0.4, post_s=0.4)
        doc = pipeline.run(video, Path(self.tmp) / "out", settings)
        self.assertEqual(len(doc["swings"]), len(CLICK_TIMES))
        self.assertIn(doc["source"]["rotation"], (90, 270))
        # Crop rects must fit the display frame, not the coded frame.
        root = session.out_root(Path(self.tmp) / "out", video)
        for ref in doc["swings"]:
            swing = session.read_json(os.path.join(root, ref["dir"],
                                                   "metadata.json"))
            crop_rect = swing["crop"]
            self.assertLessEqual(crop_rect["x"] + crop_rect["w"],
                                 doc["source"]["width"])
            self.assertLessEqual(crop_rect["y"] + crop_rect["h"],
                                 doc["source"]["height"])
        checked, problems = session.validate_tree(root)
        self.assertEqual(problems, [], problems[:2])


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestSilentVideo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_fails_loudly_rather_than_degrading(self):
        out = Path(self.tmp) / "silent.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
             "testsrc=size=320x240:rate=30:duration=3", "-an",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(out)],
            check=True, capture_output=True)
        with self.assertRaises(Exception) as ctx:
            pipeline.run(out, Path(self.tmp) / "out", config.Settings(
                pose_backend="stub"))
        self.assertIn("audio", str(ctx.exception).lower())


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.video = make_session_video(self.tmp, duration=10)

    def test_probe_command(self):
        self.assertEqual(cli.main(["probe", str(self.video)]), 0)

    def test_detect_dry_run_writes_nothing(self):
        outdir = Path(self.tmp) / "out"
        code = cli.main(["detect", str(self.video), "--dry-run",
                         "--pose-backend=stub"])
        self.assertEqual(code, 0)
        self.assertFalse(outdir.exists())

    def test_run_then_validate(self):
        outdir = Path(self.tmp) / "out"
        code = cli.main(["run", str(self.video), "--outdir", str(outdir),
                         "--pose-backend=stub", "--span", "0.3",
                         "--long-edge", "160", "--clip-height", "240",
                         "--pre", "0.4", "--post", "0.4", "--quiet"])
        self.assertEqual(code, 0)
        root = session.out_root(outdir, self.video)
        self.assertEqual(cli.main(["validate", root]), 0)

    def test_run_honours_limit(self):
        outdir = Path(self.tmp) / "out"
        cli.main(["run", str(self.video), "--outdir", str(outdir),
                  "--pose-backend=stub", "--limit", "1", "--span", "0.2",
                  "--long-edge", "160", "--quiet"])
        root = session.out_root(outdir, self.video)
        doc = session.read_json(os.path.join(root, "metadata.json"))
        self.assertEqual(len(doc["swings"]), 1)

    def test_show_frames_table(self):
        outdir = Path(self.tmp) / "out"
        cli.main(["run", str(self.video), "--outdir", str(outdir),
                  "--pose-backend=stub", "--span", "0.2", "--long-edge",
                  "160", "--limit", "1", "--quiet"])
        root = session.out_root(outdir, self.video)
        swing = os.path.join(root, "swings", "swing_001")
        self.assertEqual(cli.main(["show", swing, "--frames"]), 0)

    def test_validate_reports_a_broken_tree(self):
        root = Path(self.tmp) / "broken"
        root.mkdir()
        session.write_json(root / "metadata.json", {"schema": "wrong"})
        self.assertEqual(cli.main(["validate", str(root)]), 1)

    def test_bad_settings_are_rejected(self):
        with self.assertRaises(SystemExit):
            cli.main(["run", str(self.video), "--quality", "0"])

    def test_missing_video_exits_nonzero(self):
        self.assertEqual(cli.main(["probe", str(Path(self.tmp) / "no.mp4")]), 2)


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg/ffprobe")
class TestDefaultSettingsEndToEnd(unittest.TestCase):
    """The defaults, changing nothing but the backend.

    Every other end-to-end test tunes the settings down to keep the fixture
    small -- and in doing so stopped exercising the configuration real users
    get. Three defects lived in that blind spot at once:

      * frame_span_s (1.6) is wider than 2*pose_window_s (0.8), so the outer
        stills legitimately have no pose_score, which the validator then
        rejected. Every default run wrote a clip and 49 JPEGs and *then*
        raised, so no session document was ever produced.
      * pose_tiles defaulting to 0 selected MediaPipe's VIDEO running mode,
        which rejects the non-monotonic timestamps this pipeline hands it.
      * the pose cache key ignored pose_backend.

    pose_backend is the one override, and it is unavoidable: MediaPipe
    aborts the process without a window server. Everything else must stay
    whatever config.Settings() says -- do not "fix" a failure here by
    narrowing the span.
    """

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        # 20s, so a swing's full +/-800ms frame span sits well inside.
        cls.video = make_session_video(cls.tmp, duration=20)
        cls.outdir = Path(cls.tmp) / "out"
        cls.settings = config.Settings(pose_backend="stub")
        cls.doc = pipeline.run(cls.video, cls.outdir, cls.settings)
        cls.root = session.out_root(cls.outdir, cls.video)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_defaults_are_internally_consistent(self):
        self.assertEqual(config.Settings().validate(), [])

    def test_run_completes_and_writes_a_session_document(self):
        self.assertEqual(schema.validate_session(self.doc), [])
        self.assertTrue(self.doc["swings"],
                        "no swings survived a default run")
        self.assertTrue(os.path.exists(
            os.path.join(self.root, "metadata.json")))
        checked, problems = session.validate_tree(self.root)
        self.assertEqual(problems, [])
        self.assertGreater(checked, 1)

    def test_frames_outside_the_pose_window_may_lack_a_score(self):
        """The exact shape that used to abort the run.

        A default swing spans +/-800ms of stills over a +/-400ms pose
        window, so roughly half the frames carry pose_score: null while
        `measurements` is fully populated. That document must validate.
        """
        with open(os.path.join(self.root, self.doc["swings"][0]["dir"],
                               "metadata.json")) as fh:
            swing = json.load(fh)

        self.assertIsNotNone(swing["measurements"])
        scored = [f for f in swing["frames"] if f["pose_score"] is not None]
        unscored = [f for f in swing["frames"] if f["pose_score"] is None]
        self.assertTrue(scored, "no frame carried a pose score")
        self.assertTrue(unscored,
                        "expected scoreless frames at the span edges; if this "
                        "fails the defaults changed and the regression is no "
                        "longer covered")
        self.assertEqual(schema.validate_swing(swing), [])

    def test_rerun_reuses_the_pose_cache(self):
        cache = os.path.join(self.root, "work", "pose.jsonl.gz")
        self.assertTrue(os.path.exists(cache))
        stamp = os.path.getmtime(cache)
        pipeline.run(self.video, self.outdir, self.settings)
        self.assertEqual(os.path.getmtime(cache), stamp,
                         "second run rewrote a cache it should have reused")


if __name__ == "__main__":
    unittest.main()
