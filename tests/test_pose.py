"""Tests for the pose backend interface, Landmarks maths, and dedupe."""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import pose


def body(cx=0.5, shoulder_y=0.40, hip_y=0.55, nose_y=0.30,
         l_wrist=(0.30, 0.50), r_wrist=(0.70, 0.50), visibility=0.9):
    points = [(cx, shoulder_y, visibility)] * pose.N_LANDMARKS
    points = list(points)
    points[pose.NOSE] = (cx, nose_y, visibility)
    points[pose.L_SHOULDER] = (cx - 0.05, shoulder_y, visibility)
    points[pose.R_SHOULDER] = (cx + 0.05, shoulder_y, visibility)
    points[pose.L_HIP] = (cx - 0.04, hip_y, visibility)
    points[pose.R_HIP] = (cx + 0.04, hip_y, visibility)
    points[pose.L_WRIST] = (l_wrist[0], l_wrist[1], visibility)
    points[pose.R_WRIST] = (r_wrist[0], r_wrist[1], visibility)
    return pose.Landmarks(points, score=0.9)


class TestLandmarks(unittest.TestCase):
    def test_torso_height(self):
        self.assertAlmostEqual(body(shoulder_y=0.4, hip_y=0.55).torso_height(),
                               0.15, places=6)

    def test_torso_height_is_positive_when_inverted(self):
        self.assertAlmostEqual(body(shoulder_y=0.6, hip_y=0.4).torso_height(),
                               0.20, places=6)

    def test_center_x_is_the_body_midline(self):
        self.assertAlmostEqual(body(cx=0.5).center_x(), 0.5, places=6)
        self.assertAlmostEqual(body(cx=0.2).center_x(), 0.2, places=6)

    def test_center_x_ignores_arm_position(self):
        """Midline must come from torso, not limbs -- a reached arm must not
        drag it."""
        wide = body(cx=0.5, r_wrist=(0.95, 0.5))
        self.assertAlmostEqual(wide.center_x(), 0.5, places=6)

    def test_xy_and_visible(self):
        b = body(r_wrist=(0.7, 0.5))
        self.assertEqual(b.xy(pose.R_WRIST), (0.7, 0.5))
        self.assertTrue(b.visible(pose.R_WRIST))
        low = body(visibility=0.1)
        self.assertFalse(low.visible(pose.R_WRIST))

    def test_bbox_covers_visible_points(self):
        b = body(cx=0.5, l_wrist=(0.20, 0.60), r_wrist=(0.80, 0.25))
        x0, y0, x1, y1 = b.bbox()
        self.assertAlmostEqual(x0, 0.20, places=6)
        self.assertAlmostEqual(x1, 0.80, places=6)
        self.assertLessEqual(y0, 0.25)
        self.assertGreaterEqual(y1, 0.60)

    def test_bbox_falls_back_when_nothing_visible(self):
        b = body(visibility=0.0)
        self.assertEqual(len(b.bbox()), 4)

    def test_json_round_trip(self):
        b = body()
        back = pose.Landmarks.from_json(b.to_json())
        self.assertEqual(len(back.points), pose.N_LANDMARKS)
        self.assertAlmostEqual(back.torso_height(), b.torso_height(), places=4)
        self.assertAlmostEqual(back.center_x(), b.center_x(), places=4)

    def test_json_is_compact_enough_for_per_swing_storage(self):
        """pose.json holds ~49 frames; rounding keeps it small."""
        import json
        blob = json.dumps(body().to_json())
        self.assertLess(len(blob), 1200, "%d bytes per pose is too fat"
                        % len(blob))


class TestDedupe(unittest.TestCase):
    def test_drops_near_duplicates(self):
        got = pose.dedupe([body(cx=0.5), body(cx=0.51)])
        self.assertEqual(len(got), 1)

    def test_keeps_distinct_players(self):
        got = pose.dedupe([body(cx=0.2), body(cx=0.8)])
        self.assertEqual(len(got), 2)

    def test_sorts_left_to_right(self):
        got = pose.dedupe([body(cx=0.8), body(cx=0.2), body(cx=0.5)])
        xs = [round(p.center_x(), 3) for p in got]
        self.assertEqual(xs, sorted(xs))

    def test_same_x_different_depth_is_kept(self):
        """Two players one behind the other are two players."""
        got = pose.dedupe([body(cx=0.5, nose_y=0.2), body(cx=0.5, nose_y=0.7)])
        self.assertEqual(len(got), 2)

    def test_empty(self):
        self.assertEqual(pose.dedupe([]), [])


class TestStubBackend(unittest.TestCase):
    def setUp(self):
        self.frame = np.zeros((240, 320, 3), np.uint8)

    def test_returns_one_body_by_default(self):
        with pose.StubBackend() as backend:
            got = backend.detect(self.frame, 0)
        self.assertEqual(len(got), 1)
        self.assertEqual(len(got[0].points), pose.N_LANDMARKS)

    def test_returns_requested_player_count_left_to_right(self):
        with pose.StubBackend(players=2) as backend:
            got = backend.detect(self.frame, 0)
        self.assertEqual(len(got), 2)
        self.assertLess(got[0].center_x(), got[1].center_x())

    def test_wrist_moves_across_calls(self):
        """Downstream needs a wrist that actually travels."""
        with pose.StubBackend() as backend:
            xs = [backend.detect(self.frame, i * 33)[0].xy(pose.R_WRIST)[0]
                  for i in range(12)]
        self.assertGreater(max(xs) - min(xs), 0.1)

    def test_hitting_wrist_moves_more_than_the_free_arm(self):
        """The stub must exercise the peak-speed rule, not defeat it."""
        with pose.StubBackend() as backend:
            frames = [backend.detect(self.frame, i * 33)[0] for i in range(12)]
        right = [f.xy(pose.R_WRIST)[0] for f in frames]
        left = [f.xy(pose.L_WRIST)[0] for f in frames]
        self.assertGreater(max(right) - min(right), max(left) - min(left))

    def test_free_arm_reaches_further_from_the_midline(self):
        """This is the trap the old code fell into: the free arm is wider.

        The stub reproduces it so verify.py's peak-speed selection is
        tested against the real failure mode rather than a friendly case.
        """
        with pose.StubBackend() as backend:
            first = backend.detect(self.frame, 0)[0]
        mid = first.center_x()
        left_reach = abs(first.xy(pose.L_WRIST)[0] - mid)
        right_reach = abs(first.xy(pose.R_WRIST)[0] - mid)
        self.assertGreater(left_reach, right_reach)

    def test_script_is_replayed_in_order(self):
        a, b = [body(cx=0.2)], [body(cx=0.8)]
        with pose.StubBackend(script=[a, b]) as backend:
            self.assertAlmostEqual(backend.detect(self.frame)[0].center_x(),
                                   0.2, places=3)
            self.assertAlmostEqual(backend.detect(self.frame)[0].center_x(),
                                   0.8, places=3)
            self.assertAlmostEqual(backend.detect(self.frame)[0].center_x(),
                                   0.2, places=3)

    def test_script_can_yield_no_detection(self):
        with pose.StubBackend(script=[[]]) as backend:
            self.assertEqual(backend.detect(self.frame), [])

    def test_counts_calls(self):
        with pose.StubBackend() as backend:
            for i in range(5):
                backend.detect(self.frame, i)
            self.assertEqual(backend.calls, 5)


class TestBackendFactory(unittest.TestCase):
    def test_makes_stub(self):
        self.assertIsInstance(pose.make_backend("stub"), pose.StubBackend)

    def test_rejects_unknown(self):
        with self.assertRaises(pose.PoseError):
            pose.make_backend("telepathy")

    def test_mediapipe_fails_clearly_without_a_display(self):
        """Must raise with an explanation, never abort the process."""
        if pose.has_display():
            self.skipTest("this session has a display")
        with self.assertRaises(pose.PoseError) as ctx:
            pose.make_backend("mediapipe")
        self.assertIn("window-server", str(ctx.exception))

    def test_has_display_returns_a_bool(self):
        self.assertIsInstance(pose.has_display(), bool)


if __name__ == "__main__":
    unittest.main()
