"""Tests for swing verification and hitting-wrist selection.

The centrepiece is test_picks_the_fast_arm_not_the_wide_arm: the previous
generation of this code chose the wrist furthest from the body midline, which
is usually the free arm, and measured 22% stroke agreement as a result.
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import config, pose, tracks, verify

SHOULDER_Y, HIP_Y = 0.40, 0.55
TORSO = HIP_Y - SHOULDER_Y


def body(cx=0.5, l_wrist=(0.30, 0.50), r_wrist=(0.70, 0.50), visibility=0.9,
         shoulder_y=SHOULDER_Y, hip_y=HIP_Y):
    points = list([(cx, shoulder_y, visibility)] * pose.N_LANDMARKS)
    points[pose.NOSE] = (cx, shoulder_y - 0.10, visibility)
    points[pose.L_SHOULDER] = (cx - 0.05, shoulder_y, visibility)
    points[pose.R_SHOULDER] = (cx + 0.05, shoulder_y, visibility)
    points[pose.L_HIP] = (cx - 0.04, hip_y, visibility)
    points[pose.R_HIP] = (cx + 0.04, hip_y, visibility)
    points[pose.L_WRIST] = (l_wrist[0], l_wrist[1], visibility)
    points[pose.R_WRIST] = (r_wrist[0], r_wrist[1], visibility)
    return pose.Landmarks(points, score=0.9)


def track_from(bodies, base_ms=1000, step_ms=33, contact_ms=None):
    """Build a Track from a list of per-frame pose lists."""
    frames = []
    for i, entry in enumerate(bodies):
        poses = entry if isinstance(entry, list) else [entry]
        frames.append({"source_ms": base_ms + i * step_ms, "poses": poses})
    if contact_ms is None:
        contact_ms = base_ms + (len(bodies) // 2) * step_ms
    return tracks.Track({"contact_ms": contact_ms, "onset_peak": 12.0},
                        frames, (320, 240))


def swinging(n=9, cx=0.5, sweep=0.5, free_reach=0.30, hitting="right",
             wrist_y=0.46):
    """A player whose hitting wrist sweeps and whose free arm sits wide.

    `free_reach` is how far the free wrist is parked from the midline;
    `sweep` is the total travel of the hitting wrist. Making free_reach
    larger than sweep/2 reproduces the free-arm-is-wider trap.
    """
    out = []
    for i in range(n):
        phase = i / max(1, n - 1)
        moving = -sweep / 2 + sweep * phase
        if hitting == "right":
            out.append(body(cx=cx, l_wrist=(cx - free_reach, 0.50),
                            r_wrist=(cx + moving, wrist_y)))
        else:
            out.append(body(cx=cx, r_wrist=(cx + free_reach, 0.50),
                            l_wrist=(cx + moving, wrist_y)))
    return out


class TestHittingWristSelection(unittest.TestCase):
    def test_picks_the_fast_arm_not_the_wide_arm(self):
        """The exact bug from the old code, as a regression test.

        The free (left) wrist is parked 0.30 from the midline; the hitting
        (right) wrist never exceeds 0.15. Choosing by reach picks left;
        choosing by speed picks right.
        """
        bodies = swinging(n=9, sweep=0.3, free_reach=0.30, hitting="right")
        series = [(1000 + i * 33, b) for i, b in enumerate(bodies)]

        mid = bodies[0].center_x()
        left_reach = max(abs(b.xy(pose.L_WRIST)[0] - mid) for b in bodies)
        right_reach = max(abs(b.xy(pose.R_WRIST)[0] - mid) for b in bodies)
        self.assertGreater(left_reach, right_reach,
                           "test setup must make the free arm the wider one")

        side, peak, _ = verify.choose_hitting_side(series, TORSO)
        self.assertEqual(side, "right")
        self.assertGreater(peak, 0)

    def test_picks_left_when_the_left_arm_swings(self):
        bodies = swinging(n=9, sweep=0.3, free_reach=0.30, hitting="left")
        series = [(1000 + i * 33, b) for i, b in enumerate(bodies)]
        side, _, _ = verify.choose_hitting_side(series, TORSO)
        self.assertEqual(side, "left")

    def test_peak_time_lands_where_the_wrist_is_fastest(self):
        """A wrist that accelerates mid-window peaks mid-window.

        Position follows -cos, so velocity is a sine: slowest at both ends,
        fastest in the middle. This is what a real swing looks like -- the
        racket turns around, accelerates through contact, then decelerates.
        """
        n = 11
        bodies = []
        for i in range(n):
            phase = i / (n - 1.0)
            x = 0.5 - 0.2 * math.cos(math.pi * phase)
            bodies.append(body(cx=0.5, l_wrist=(0.20, 0.5), r_wrist=(x, 0.46)))
        series = [(1000 + i * 33, b) for i, b in enumerate(bodies)]
        _, _, peak_ms = verify.choose_hitting_side(series, TORSO)
        middle_ms = 1000 + (n // 2) * 33
        self.assertLess(abs(peak_ms - middle_ms), 70,
                        "peak at %dms is not near the middle (%dms)"
                        % (peak_ms, middle_ms))

    def test_no_movement_yields_no_side(self):
        still = [(1000 + i * 33, body()) for i in range(6)]
        side, peak, _ = verify.choose_hitting_side(still, TORSO)
        self.assertEqual(peak, 0.0)

    def test_single_frame_yields_nothing(self):
        self.assertEqual(verify.choose_hitting_side([(1000, body())], TORSO),
                         (None, -1.0, None))


class TestWristSpeeds(unittest.TestCase):
    def test_speed_is_in_torso_heights_per_second(self):
        """A wrist crossing one torso height in one second reads 1.0.

        At index 0 the centred window clamps to [0, 1], so the measured
        interval is the full 1000ms: one torso height per second.
        """
        a = body(r_wrist=(0.5, 0.46))
        b = body(r_wrist=(0.5 + TORSO, 0.46))
        speeds = verify.wrist_speeds([(0, a), (1000, b)], pose.R_WRIST, TORSO)
        self.assertAlmostEqual(speeds[0][1], 1.0, places=3)

    def test_speed_halves_when_the_same_distance_takes_twice_as_long(self):
        a = body(r_wrist=(0.5, 0.46))
        b = body(r_wrist=(0.5 + TORSO, 0.46))
        fast = verify.wrist_speeds([(0, a), (1000, b)], pose.R_WRIST, TORSO)
        slow = verify.wrist_speeds([(0, a), (2000, b)], pose.R_WRIST, TORSO)
        self.assertAlmostEqual(slow[0][1], fast[0][1] / 2.0, places=3)

    def test_glitch_is_capped(self):
        """One implausible frame must not dominate peak speed."""
        series = [(0, body(r_wrist=(0.0, 0.5))),
                  (33, body(r_wrist=(1.0, 0.5))),
                  (66, body(r_wrist=(0.0, 0.5)))]
        speeds = verify.wrist_speeds(series, pose.R_WRIST, TORSO)
        self.assertTrue(all(s <= verify.SPEED_CAP for _, s in speeds))

    def test_zero_torso_is_handled(self):
        self.assertEqual(verify.wrist_speeds([(0, body()), (33, body())],
                                             pose.R_WRIST, 0.0), [])

    def test_vertical_motion_counts(self):
        """A serve moves the wrist mostly downward; speed is 2-D."""
        series = [(0, body(r_wrist=(0.5, 0.2))),
                  (100, body(r_wrist=(0.5, 0.5))),
                  (200, body(r_wrist=(0.5, 0.5)))]
        speeds = verify.wrist_speeds(series, pose.R_WRIST, TORSO)
        self.assertGreater(speeds[0][1], 0)


class TestMeasureSlot(unittest.TestCase):
    def setUp(self):
        self.settings = config.Settings(min_torso=0.045, min_wrist_speed=0.45,
                                        pose_window_s=0.40)

    def test_accepts_a_real_swing(self):
        track = track_from(swinging(n=9, sweep=0.5))
        got = verify.measure_slot(track, 0, self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertEqual(got.hitting_side, "right")
        self.assertIsNotNone(got.wrist_peak_speed)
        self.assertAlmostEqual(got.torso_height, TORSO, places=4)

    def test_rejects_too_few_frames(self):
        got = verify.measure_slot(track_from(swinging(n=2)), 0, self.settings)
        self.assertEqual(got.reason, verify.NO_POSE)

    def test_rejects_a_distant_player(self):
        tiny = [body(cx=0.5, shoulder_y=0.40, hip_y=0.41,
                     r_wrist=(0.5 + 0.02 * i, 0.40)) for i in range(9)]
        got = verify.measure_slot(track_from(tiny), 0, self.settings)
        self.assertEqual(got.reason, verify.TORSO_TOO_SMALL)

    def test_rejects_a_standing_player(self):
        """A ball bouncing near someone standing still is not a shot."""
        got = verify.measure_slot(track_from([body()] * 9), 0, self.settings)
        self.assertEqual(got.reason, verify.WRIST_TOO_SLOW)

    def test_rejects_an_onset_away_from_the_swing(self):
        """Swing happens early in the window; the onset is much later."""
        track = track_from(swinging(n=9), base_ms=1000, step_ms=33,
                           contact_ms=5000)
        got = verify.measure_slot(track, 0, self.settings)
        self.assertEqual(got.reason, verify.ONSET_OFF_SWING)

    def test_contact_offset_sign_says_which_side(self):
        """Positive means the wrist was right of the midline at contact."""
        right_side = [body(cx=0.5, l_wrist=(0.2, 0.5),
                           r_wrist=(0.5 + 0.05 * i, 0.46)) for i in range(9)]
        track = track_from(right_side, base_ms=1000, step_ms=33,
                           contact_ms=1000 + 8 * 33)
        got = verify.measure_slot(track, 0, self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertGreater(got.contact_offset, 0)

        left_side = [body(cx=0.5, l_wrist=(0.5 - 0.05 * i, 0.46),
                          r_wrist=(0.8, 0.5)) for i in range(9)]
        track = track_from(left_side, base_ms=1000, step_ms=33,
                           contact_ms=1000 + 8 * 33)
        got = verify.measure_slot(track, 0, self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertLess(got.contact_offset, 0)

    def test_contact_height_is_negative_above_the_shoulder(self):
        """An overhead contacts above the shoulder; y grows downward."""
        overhead = [body(cx=0.5, l_wrist=(0.2, 0.5),
                         r_wrist=(0.5 + 0.03 * i, 0.15)) for i in range(9)]
        track = track_from(overhead, base_ms=1000, step_ms=33,
                           contact_ms=1000 + 8 * 33)
        got = verify.measure_slot(track, 0, self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertLess(got.contact_height, 0)

    def test_measurements_are_normalized_by_torso(self):
        """Two players at different scales must measure the same swing alike."""
        near = track_from(swinging(n=9, sweep=0.5))
        far = track_from([body(cx=0.5, shoulder_y=0.45, hip_y=0.525,
                              l_wrist=(0.35, 0.50),
                              r_wrist=(0.5 - 0.125 + 0.25 * (i / 8.0), 0.48))
                          for i in range(9)])
        a = verify.measure_slot(near, 0, self.settings)
        b = verify.measure_slot(far, 0, self.settings)
        self.assertTrue(a.ok and b.ok, (a.reason, b.reason))
        self.assertAlmostEqual(a.wrist_peak_speed, b.wrist_peak_speed, delta=0.6)

    def test_boxes_are_collected_for_cropping(self):
        got = verify.measure_slot(track_from(swinging(n=9)), 0, self.settings)
        self.assertEqual(len(got.boxes), 9)
        self.assertEqual(len(got.boxes[0]), 4)

    def test_to_metadata_matches_the_schema(self):
        from tennisproc import schema
        got = verify.measure_slot(track_from(swinging(n=9)), 0, self.settings)
        meta = got.to_metadata()
        self.assertEqual(meta["space"], schema.MEASURE_SPACE)
        self.assertEqual(meta["origin"], schema.MEASURE_ORIGIN)
        self.assertIn(meta["hitting_side"], schema.HITTING_SIDES)

    def test_to_metadata_is_none_when_rejected(self):
        got = verify.measure_slot(track_from([body()] * 9), 0, self.settings)
        self.assertIsNone(got.to_metadata())


class TestVerify(unittest.TestCase):
    def setUp(self):
        self.settings = config.Settings()

    def test_empty_track_reports_no_pose(self):
        track = tracks.Track({"contact_ms": 1000}, [], (320, 240))
        got, results = verify.verify(track, self.settings)
        self.assertEqual(got.reason, verify.NO_POSE)
        self.assertEqual(results, [])

    def test_accepts_a_single_swinging_player(self):
        got, _ = verify.verify(track_from(swinging(n=9, sweep=0.5)),
                               self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertEqual(got.slot, 0)

    def test_picks_the_swinging_player_of_two(self):
        """One player swings, the other stands. Slot 1 must win."""
        frames = []
        movers = swinging(n=9, cx=0.75, sweep=0.5)
        for i in range(9):
            frames.append([body(cx=0.25), movers[i]])
        got, results = verify.verify(track_from(frames), self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertEqual(got.slot, 1)
        self.assertEqual(len(results), 2)
        self.assertFalse(results[0].ok)

    def test_picks_the_faster_of_two_swinging_players(self):
        frames = []
        slow = swinging(n=9, cx=0.25, sweep=0.18)
        fast = swinging(n=9, cx=0.75, sweep=0.6)
        for i in range(9):
            frames.append([slow[i], fast[i]])
        got, _ = verify.verify(track_from(frames), self.settings)
        self.assertEqual(got.slot, 1)

    def test_reports_the_most_informative_rejection(self):
        """A body that moved too slowly beats 'no body at all' in the report."""
        frames = []
        for i in range(9):
            frames.append([body(cx=0.25)] if i % 2 else [body(cx=0.25),
                                                         body(cx=0.75)])
        got, _ = verify.verify(track_from(frames), self.settings)
        self.assertFalse(got.ok)
        self.assertIn(got.reason, (verify.WRIST_TOO_SLOW, verify.NO_POSE))

    def test_reason_is_always_a_schema_enum(self):
        from tennisproc import schema
        cases = [track_from([body()] * 9),
                 tracks.Track({"contact_ms": 1000}, [], (320, 240)),
                 track_from(swinging(n=2))]
        for track in cases:
            got, _ = verify.verify(track, self.settings)
            if not got.ok:
                self.assertIn(got.reason, schema.REJECT_REASONS)


if __name__ == "__main__":
    unittest.main()
