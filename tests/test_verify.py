"""Tests for swing verification and hitting-wrist selection.

The centrepiece is test_picks_the_fast_arm_not_the_wide_arm: the previous
generation of this code chose the wrist furthest from the body midline, which
is usually the free arm, and measured 22% stroke agreement as a result.
"""

import dataclasses
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

        Measured over the interval CENTRED on the sample, which is the only
        interval `wrist_speeds` reports. This used to pass a two-frame series
        and assert on index 0, where the window clamped to a one-sided
        difference -- the very path that biased endpoints 2x hot and put half
        of all re-anchored contacts on a window edge. There is no index 0 to
        assert on any more, by design.
        """
        a = body(r_wrist=(0.5, 0.46))
        mid = body(r_wrist=(0.5 + TORSO / 2.0, 0.46))
        b = body(r_wrist=(0.5 + TORSO, 0.46))
        speeds = verify.wrist_speeds([(0, a), (500, mid), (1000, b)],
                                     pose.R_WRIST, TORSO)
        self.assertEqual(len(speeds), 1)
        self.assertEqual(speeds[0][0], 500)
        self.assertAlmostEqual(speeds[0][1], 1.0, places=3)

    def test_speed_halves_when_the_same_distance_takes_twice_as_long(self):
        a = body(r_wrist=(0.5, 0.46))
        mid = body(r_wrist=(0.5 + TORSO / 2.0, 0.46))
        b = body(r_wrist=(0.5 + TORSO, 0.46))
        fast = verify.wrist_speeds([(0, a), (500, mid), (1000, b)],
                                   pose.R_WRIST, TORSO)
        slow = verify.wrist_speeds([(0, a), (1000, mid), (2000, b)],
                                   pose.R_WRIST, TORSO)
        self.assertAlmostEqual(slow[0][1], fast[0][1] / 2.0, places=3)

    def test_endpoints_are_not_reported_at_all(self):
        """The bias that broke re-anchoring, pinned.

        A one-sided difference over half the baseline is not the same
        measurement as a centred one: identical detector jitter reads about
        twice as fast there. Reporting both kinds in one series and taking
        `argmax` put contact on the first or last decoded frame in 50% of
        tracks against 8% by chance -- 17 of 48 re-anchored swings in one real
        session, at exactly +-pose_window_s from the onset.
        """
        series = [(i * 33, body(r_wrist=(0.5, 0.46))) for i in range(5)]
        speeds = verify.wrist_speeds(series, pose.R_WRIST, TORSO)
        self.assertEqual([t for t, _ in speeds], [33, 66, 99])

    def test_a_track_too_short_to_have_an_interior_reports_nothing(self):
        two = [(0, body()), (33, body())]
        self.assertEqual(verify.wrist_speeds(two, pose.R_WRIST, TORSO), [])

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

    def test_an_onset_away_from_the_swing_is_kept_at_its_onset(self):
        """A shot whose wrist peak is elsewhere is still a shot, at the sound.

        Three behaviours have lived here. Rejecting it threw away real shots --
        25 of 29 candidates on IMG_0304, four of them in `known_shots.json`.
        Moving contact to the wrist peak recovered them and then put contact in
        the wrong place: measured against 12 verified shot times, recall was
        100% on the onset and 58% on the moved value, with the moved value
        0.2-0.35s away on every shot it touched.

        So: keep the swing, keep contact where the audio put it.
        """
        track = track_from(swinging(n=9), base_ms=1000, step_ms=33,
                           contact_ms=1264)
        settings = dataclasses.replace(self.settings, reanchor_min_speed=0.0)
        got = verify.measure_slot(track, 0, settings)
        self.assertIsNone(got.reason)
        self.assertFalse(got.reanchored)
        self.assertEqual(got.contact_ms, 1264)

    def test_a_slow_swing_far_from_its_onset_is_rejected(self):
        """Far AND slow means nobody was swinging when the sound happened.

        This is the surviving half of the re-anchor work: the peak's distance
        from the onset is evidence about the candidate, not a correction to
        apply to it. Gated by `reanchor_min_speed`, swept at
        `config.Settings.reanchor_min_speed` -- 12.0 keeps 100% recall on the
        verified shots while lifting precision from 32% to 46%.
        """
        track = track_from(swinging(n=9), base_ms=1000, step_ms=33,
                           contact_ms=1264)
        # The gate is set above this fixture's speed rather than left at the
        # default, so the test exercises the branch instead of asserting where
        # the shipped constant happens to sit. It moved 15.0 -> 12.0 once
        # already and this test failed for that reason alone, which is the
        # signature of a test pinned to a number rather than a behaviour.
        strict = dataclasses.replace(self.settings, reanchor_min_speed=1e6)
        got = verify.measure_slot(track, 0, strict)
        self.assertEqual(got.reason, verify.PEAK_OFF_ONSET)

    def test_a_standing_player_is_still_rejected(self):
        """Re-anchoring must not become a way in for things that never swung.

        The speed and torso gates run BEFORE the onset window, so a body that
        did not swing is gone long before this can move its contact.
        """
        got = verify.measure_slot(track_from([body()] * 9), 0, self.settings)
        self.assertEqual(got.reason, verify.WRIST_TOO_SLOW)

    def test_contact_offset_sign_says_which_side(self):
        """Positive means the wrist was right of the midline at contact.

        Contact sits mid-window, as on real footage: the onset is the
        strike and the wrist is fastest through it. Declaring contact on
        the window's last frame instead leaves the peak ~230ms away, which
        is precisely what "the onset is off the swing" means.
        """
        mid_ms = 1000 + 4 * 33
        right_side = [body(cx=0.5, l_wrist=(0.2, 0.5),
                           r_wrist=(0.5 + 0.05 * i, 0.46)) for i in range(9)]
        track = track_from(right_side, base_ms=1000, step_ms=33,
                           contact_ms=mid_ms)
        got = verify.measure_slot(track, 0, self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertGreater(got.contact_offset, 0)

        left_side = [body(cx=0.5, l_wrist=(0.5 - 0.05 * i, 0.46),
                          r_wrist=(0.8, 0.5)) for i in range(9)]
        track = track_from(left_side, base_ms=1000, step_ms=33,
                           contact_ms=mid_ms)
        got = verify.measure_slot(track, 0, self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertLess(got.contact_offset, 0)

    def test_contact_height_is_negative_above_the_shoulder(self):
        """An overhead contacts above the shoulder; y grows downward."""
        overhead = [body(cx=0.5, l_wrist=(0.2, 0.5),
                         r_wrist=(0.5 + 0.03 * i, 0.15)) for i in range(9)]
        track = track_from(overhead, base_ms=1000, step_ms=33,
                           contact_ms=1000 + 4 * 33)
        got = verify.measure_slot(track, 0, self.settings)
        self.assertTrue(got.ok, got.reason)
        self.assertLess(got.contact_height, 0)

    def test_onset_gate_is_reachable_within_a_real_track_window(self):
        """Regression: the gate must be able to fire at all.

        It was compared against the full pose window, but extract_track
        clamps a track to exactly that width, so no decoded track could
        exceed it and onset_off_swing read 0 forever.
        """
        self.assertLess(verify.ONSET_WINDOW_FRACTION, 1.0)

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


class IdentityFlipsInMeasurement(unittest.TestCase):
    """A wrist that teleports to another player is not a fast swing.

    `Track.series` indexes poses positionally, so when the detector reorders
    its output the measured body changes mid-window. Over 396 shipped swings
    49% of series contained such a jump and 43% reported a peak that sat on
    one -- and because `verify` picks the slot with the fastest wrist, those
    flips were also choosing which player got measured.
    """

    def test_a_flip_produces_no_speed(self):
        near, far = 0.30, 0.75
        series = [(i * 33, body(cx=(far if i == 2 else near),
                                r_wrist=((far if i == 2 else near) + 0.2, 0.5)))
                  for i in range(5)]
        speeds = verify.wrist_speeds(series, pose.R_WRIST, TORSO)
        self.assertEqual(speeds, [])

    def test_one_body_still_measures(self):
        series = [(i * 33, body(cx=0.30, r_wrist=(0.30 + 0.02 * i, 0.5)))
                  for i in range(5)]
        self.assertEqual(len(verify.wrist_speeds(series, pose.R_WRIST, TORSO)), 3)

    def test_the_flip_no_longer_wins_slot_selection(self):
        """Two slots: one really swinging, one that merely changes identity."""
        swinger = swinging(n=9, cx=0.30, sweep=0.5)
        flipper = []
        for i in range(9):
            cx = 0.80 if i % 2 else 0.20
            flipper.append(body(cx=cx, r_wrist=(cx, 0.5)))
        track = track_from([[swinger[i], flipper[i]] for i in range(9)])
        measured, _ = verify.verify(track, config.Settings())
        self.assertTrue(measured.ok, measured.reason)
        self.assertEqual(measured.slot, 0)


class AspectRatio(unittest.TestCase):
    """x and y are each normalized to their own axis; torso height is in y.

    Mixing them without the frame aspect measures horizontal motion in
    width-fractions and divides by a height-fraction. A swing is mostly
    horizontal, so 16:9 footage understated nearly every speed by 1.78x.
    """

    def test_horizontal_speed_scales_with_the_frame(self):
        series = [(i * 100, body(cx=0.30, r_wrist=(0.30 + 0.05 * i, 0.5)))
                  for i in range(3)]
        square = verify.wrist_speeds(series, pose.R_WRIST, TORSO, 1.0)[0][1]
        wide = verify.wrist_speeds(series, pose.R_WRIST, TORSO, 16 / 9.0)[0][1]
        self.assertAlmostEqual(wide, square * 16 / 9.0, places=3)

    def test_vertical_speed_is_unaffected(self):
        series = [(i * 100, body(cx=0.30, r_wrist=(0.30, 0.50 + 0.02 * i)))
                  for i in range(3)]
        square = verify.wrist_speeds(series, pose.R_WRIST, TORSO, 1.0)[0][1]
        wide = verify.wrist_speeds(series, pose.R_WRIST, TORSO, 16 / 9.0)[0][1]
        self.assertAlmostEqual(square, wide, places=6)

    def test_frame_aspect_falls_back_when_the_size_is_unknown(self):
        track = track_from([body()] * 5)
        self.assertAlmostEqual(verify.frame_aspect(track), 320 / 240.0)
        track.frame_size = None
        self.assertEqual(verify.frame_aspect(track), 1.0)

    def test_contact_offset_is_the_same_shot_filmed_two_ways(self):
        """The same landmarks shot portrait and landscape must measure alike.

        `contact_offset` is a horizontal distance over a vertical scale, so it
        needs the aspect term for exactly the reason `wrist_speeds` does. It
        did not have one, and the corpus is 20 landscape sessions against 5
        portrait: across all 2505 shipped swings, median |contact_offset| read
        0.227 on the 16:9 sessions against 0.618 on the 9:16 ones -- a 2.7x
        split that is a property of the camera, not the player. Multiplied by
        the aspect they become 0.403 and 0.348, a ratio of 1.16.
        """
        settings = config.Settings(min_torso=0.045, min_wrist_speed=0.45,
                                   pose_window_s=0.40)
        offsets = {}
        for name, size in (("landscape", (1920, 1080)),
                           ("portrait", (1080, 1920))):
            # contact two frames past the middle, so the hitting wrist is
            # genuinely off the midline there -- at the middle frame `swinging`
            # puts it exactly on cx and every offset is 0.
            track = track_from(swinging(n=9, sweep=0.5), contact_ms=1198)
            track.frame_size = size
            measured = verify.measure_slot(track, 0, settings)
            self.assertTrue(measured.ok, measured.reason)
            offsets[name] = measured.contact_offset
        # Identical normalized landmarks, so the pixel geometry differs only by
        # each frame's aspect: divide it back out and the two must agree.
        self.assertAlmostEqual(offsets["landscape"] / (1920 / 1080.0),
                               offsets["portrait"] / (1080 / 1920.0), places=6)
        self.assertGreater(abs(offsets["landscape"]), abs(offsets["portrait"]))

    def test_contact_height_takes_no_aspect_term(self):
        """Wrist y and shoulder y are both height-normalized already."""
        settings = config.Settings(min_torso=0.045, min_wrist_speed=0.45,
                                   pose_window_s=0.40)
        heights = []
        for size in ((1920, 1080), (1080, 1920)):
            track = track_from(swinging(n=9, sweep=0.5), contact_ms=1198)
            track.frame_size = size
            heights.append(verify.measure_slot(track, 0, settings)
                           .contact_height)
        self.assertAlmostEqual(heights[0], heights[1], places=9)


class SpeedCapAndHittingSide(unittest.TestCase):
    """The cap must not decide which arm swung.

    SPEED_CAP was 40.0, which sat at the MEDIAN of real peak wrist speed
    (re-measured over 278 cached pose tracks: p50 38.2, p90 70.3, max 123). It
    flattened 63% of the shipped corpus onto one value, and because
    `choose_hitting_side` compares with a strict `>` and tries "left" first,
    every resulting tie became "left" -- 90.9% left among capped swings against
    51.6% among uncapped ones.
    """

    def test_the_cap_sits_clear_of_the_bulk_of_real_swings(self):
        # Measured across 2779 cached tracks with the cap lifted: p50 33,
        # p90 87. The cap must stay well clear of that bulk, because sitting
        # among it is what made 63% of the corpus share one value and turned
        # every LR comparison into a tie. It does NOT have to exceed the whole
        # tail -- p99 is 279 and the max 949, which are landmark jitter.
        self.assertGreater(verify.SPEED_CAP, 87.0)

    def test_equal_non_zero_peaks_do_not_silently_become_left(self):
        speeds = [(0, 10.0), (40, 10.0)]

        def fake(series, index, torso, aspect=1.0):
            return speeds

        original = verify.wrist_speeds
        verify.wrist_speeds = fake
        try:
            side, peak, _ = verify.choose_hitting_side([], torso=0.1)
        finally:
            verify.wrist_speeds = original
        self.assertIsNone(side, "a tie must be reported, not resolved by loop order")
        self.assertEqual(peak, 10.0)

    def test_a_standing_player_still_reads_as_too_slow(self):
        # Both wrists tie at 0.0 when nobody moves. That is not "cannot tell
        # the arms apart", it is "nobody swung", and `wrist_too_slow` says so
        # better and earlier than `no_wrist_track` would.
        got = verify.measure_slot(track_from([body()] * 9), 0, config.Settings())
        self.assertEqual(got.reason, verify.WRIST_TOO_SLOW)
