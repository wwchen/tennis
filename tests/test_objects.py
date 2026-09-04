"""Tests for racket and ball selection.

The detector itself is not tested here -- it is stock COCO weights, and
testing it would be testing ultralytics. What is tested is everything this
package adds on top: which of several detections belongs to the tracked
player, and whether a detected ball is in flight or lying on the court. Both
rules were chosen from measurements, and both fail in ways that produce
plausible numbers rather than crashes, which is the argument for pinning them.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import objects

TORSO = 150.0


def box(cx, cy, size=40.0, conf=0.9):
    """A square detection centred on (cx, cy)."""
    return objects.Box(cx - size / 2, cy - size / 2,
                       cx + size / 2, cy + size / 2, conf)


class BoxGeometry(unittest.TestCase):
    def test_distance_is_zero_inside_the_box(self):
        self.assertEqual(box(100, 100).distance_to((100, 100)), 0.0)
        self.assertEqual(box(100, 100).distance_to((115, 115)), 0.0)

    def test_distance_is_to_the_nearest_edge_not_the_centre(self):
        """A racket is accepted by proximity, so edge vs centre changes reach."""
        b = objects.Box(0, 0, 100, 100)
        self.assertAlmostEqual(b.distance_to((110, 50)), 10.0)

    def test_overlap_is_a_fraction_of_this_box_not_of_the_union(self):
        small = objects.Box(0, 0, 10, 10)
        big = objects.Box(0, 0, 100, 100)
        self.assertAlmostEqual(small.overlap_fraction(big), 1.0)
        self.assertAlmostEqual(big.overlap_fraction(small), 0.01)

    def test_a_degenerate_box_overlaps_nothing_rather_than_dividing_by_zero(self):
        self.assertEqual(objects.Box(5, 5, 5, 5).overlap_fraction(
            objects.Box(0, 0, 10, 10)), 0.0)


class ChooseRacket(unittest.TestCase):
    """Near a wrist OR on the player -- never both required.

    Measured over 108 swings: 53.7% recall for the wrist test alone, 38.9% for
    the overlap test alone, 62.0% for either. The two fail on different
    swings, which is the whole point of taking either.

    "A wrist", not "the hitting wrist": nothing upstream claims to know which
    arm swung any more, so both hands are offered and a racket beside either
    is the player's.
    """

    def setUp(self):
        self.player = objects.Box(400, 800, 700, 1400)

    def test_accepts_a_racket_beside_the_wrist_but_off_the_player_box(self):
        """An arm extended past the player's own box still holds the racket."""
        racket = box(900, 900)
        self.assertEqual(racket.overlap_fraction(self.player), 0.0)
        got = objects.choose_racket([racket], [(890, 900)], self.player, TORSO)
        self.assertIs(got, racket)

    def test_accepts_a_racket_on_the_player_when_the_wrist_is_misplaced(self):
        """A quarter of far-from-wrist boxes were a bad wrist, not a bad box."""
        racket = box(550, 1000)
        far_wrist = (550, 1390)      # pose put the wrist down at the ankle
        self.assertGreater(racket.distance_to(far_wrist),
                           objects.RACKET_REACH * TORSO)
        got = objects.choose_racket([racket], [far_wrist], self.player, TORSO)
        self.assertIs(got, racket)

    def test_rejects_a_racket_that_is_neither(self):
        """74.4% of far-from-wrist boxes were on nothing at all."""
        self.assertIsNone(objects.choose_racket(
            [box(50, 50)], [(600, 1000)], self.player, TORSO))

    def test_prefers_the_confident_box_among_accepted_ones(self):
        weak, strong = box(600, 950, conf=0.2), box(610, 960, conf=0.8)
        got = objects.choose_racket([weak, strong], [(600, 950)],
                                    self.player, TORSO)
        self.assertIs(got, strong)

    def test_either_hand_is_close_enough(self):
        """Both wrists are passed, so the free one must not veto the racket.

        The racket sits by the right hand; the left is across the body, well
        beyond reach. Testing only the first wrist offered would miss it --
        and which wrist comes first is exactly the choice this stage stopped
        making.
        """
        racket = box(900, 900)
        far, near = (420, 900), (890, 900)
        self.assertGreater(racket.distance_to(far),
                           objects.RACKET_REACH * TORSO)
        self.assertIs(objects.choose_racket([racket], [far, near],
                                            self.player, TORSO), racket)
        self.assertIs(objects.choose_racket([racket], [near, far],
                                            self.player, TORSO), racket)

    def test_survives_a_missing_wrist_and_a_missing_player(self):
        racket = box(550, 1000)
        self.assertIs(objects.choose_racket([racket], (), self.player, TORSO),
                      racket)
        self.assertIs(objects.choose_racket([racket], (None, None),
                                            self.player, TORSO), racket)
        self.assertIs(objects.choose_racket([racket], [(550, 1000)], None, TORSO),
                      racket)
        self.assertIsNone(objects.choose_racket([racket], (), None, TORSO))

    def test_a_zero_torso_selects_nothing_rather_than_scaling_by_zero(self):
        self.assertIsNone(objects.choose_racket(
            [box(550, 1000)], [(550, 1000)], self.player, 0.0))


class Plate(unittest.TestCase):
    def test_median_ignores_the_odd_frame_out(self):
        still = np.full((8, 8, 3), 100, np.uint8)
        moved = np.full((8, 8, 3), 250, np.uint8)
        plate = objects.short_plate([still, still, moved, still])
        self.assertTrue((plate == 100).all())

    def test_too_few_frames_yields_no_plate(self):
        f = np.zeros((4, 4, 3), np.uint8)
        self.assertIsNone(objects.short_plate([f, f]))
        self.assertIsNone(objects.short_plate([f, None, None]))

    def test_mismatched_shapes_raise_rather_than_broadcast(self):
        with self.assertRaises(objects.ObjectError):
            objects.short_plate([np.zeros((4, 4, 3), np.uint8),
                                 np.zeros((5, 4, 3), np.uint8),
                                 np.zeros((4, 4, 3), np.uint8)])


class ChooseBall(unittest.TestCase):
    """A ball is a detection AND motion. Detection alone is not evidence.

    A stock detector reported a ball at 79.2% of control moments when nothing
    was being struck, because the court fills with dead balls as a session
    runs. Motion against a short plate is what separates them.
    """

    def scene(self, ball_value, plate_value):
        frame = np.full((200, 200, 3), 30, np.uint8)
        plate = np.full((200, 200, 3), 30, np.uint8)
        frame[95:105, 95:105] = ball_value
        plate[95:105, 95:105] = plate_value
        return frame, plate

    def test_a_ball_in_flight_is_kept(self):
        frame, plate = self.scene(220, 30)      # absent from the plate
        got = objects.choose_ball([box(100, 100, size=10)], frame, plate, TORSO)
        self.assertIsNotNone(got)
        self.assertGreaterEqual(got[1], objects.BALL_MOTION)

    def test_a_ball_lying_on_the_court_is_dropped(self):
        frame, plate = self.scene(220, 220)     # present in the plate
        self.assertIsNone(objects.choose_ball(
            [box(100, 100, size=10)], frame, plate, TORSO))

    def test_a_limb_sized_blob_is_dropped_however_fast_it_moves(self):
        """Motion alone cannot tell a ball from a shoe; size is the other half."""
        frame = np.full((400, 400, 3), 30, np.uint8)
        plate = np.full((400, 400, 3), 30, np.uint8)
        frame[100:300, 100:300] = 240
        huge = objects.Box(100, 100, 300, 300)
        self.assertGreater(huge.area / (TORSO * TORSO), objects.BALL_AREA[1])
        self.assertIsNone(objects.choose_ball([huge], frame, plate, TORSO))

    def test_the_fastest_moving_ball_wins(self):
        frame = np.full((200, 200, 3), 30, np.uint8)
        plate = np.full((200, 200, 3), 30, np.uint8)
        frame[45:55, 45:55] = 90       # barely moving
        frame[95:105, 95:105] = 250    # clearly flying
        got = objects.choose_ball([box(50, 50, size=10), box(100, 100, size=10)],
                                  frame, plate, TORSO)
        self.assertAlmostEqual(got[0].centre[0], 100.0)

    def test_no_plate_means_no_ball_rather_than_every_ball(self):
        frame = np.full((200, 200, 3), 30, np.uint8)
        self.assertIsNone(objects.choose_ball(
            [box(100, 100, size=10)], frame, None, TORSO))

    def test_a_box_outside_the_frame_scores_zero_rather_than_raising(self):
        frame = np.full((50, 50, 3), 30, np.uint8)
        plate = np.full((50, 50, 3), 30, np.uint8)
        self.assertEqual(objects.motion_score(frame, plate,
                                              objects.Box(500, 500, 520, 520)),
                         0.0)


class Backends(unittest.TestCase):
    def test_none_means_the_stage_does_not_run(self):
        self.assertIsNone(objects.make_backend("none"))
        self.assertIsNone(objects.make_backend(None))

    def test_unknown_names_fail_here_not_several_stages_later(self):
        with self.assertRaises(objects.ObjectError):
            objects.make_backend("yolo-typo")

    def test_the_stub_lets_measure_run_with_no_model(self):
        racket = box(600, 950)
        player = objects.Box(400, 800, 700, 1400)
        backend = objects.StubObjectBackend(
            [{"racket": [racket], "ball": [], "person": [player]}])
        frame = np.zeros((1920, 1080, 3), np.uint8)
        doc = objects.measure(backend, frame, frame,
                              objects.Box(450, 850, 650, 1350),
                              [(600, 950)], TORSO)
        self.assertEqual(doc["space"], "source_display")
        self.assertEqual(doc["detector"], "stub/coco")
        self.assertIsNotNone(doc["racket"])
        self.assertIsNone(doc["ball"])

    def test_measure_reports_ball_to_racket_distance_in_torso_heights(self):
        racket = objects.Box(0, 0, 100, 100, 0.9)
        ball = objects.Box(240, 45, 250, 55, 0.5)
        frame = np.full((300, 300, 3), 30, np.uint8)
        plate = np.full((300, 300, 3), 30, np.uint8)
        frame[45:55, 240:250] = 250
        backend = objects.StubObjectBackend(
            [{"racket": [racket], "ball": [ball], "person": []}])
        doc = objects.measure(backend, frame, plate, None, [(50, 50)], TORSO)
        self.assertIsNotNone(doc["ball"])
        # nearest edge of the racket box to the ball centre: 245 - 100 = 145 px
        self.assertAlmostEqual(doc["ball"]["racket_distance"],
                               round(145.0 / TORSO, 3), places=3)


if __name__ == "__main__":
    unittest.main()


class SchemaBlock(unittest.TestCase):
    """The `objects` block must validate, including its absent-field cases.

    `optional=True` in schema.py means "may be null", never "may be absent",
    so every present-only field needs an explicit `in` guard. Getting that
    wrong rejects every swing that predates the field.
    """

    def doc(self, objects):
        from tennisproc import session
        source = {"name": "X.MOV", "path": "raw/X.MOV", "sha256_16": "0" * 16,
                  "bytes": 1, "modified": None, "duration_ms": 1000,
                  "fps": 60.0, "vfr": False, "width": 1080, "height": 1920,
                  "rotation": 0, "has_audio": True, "audio_sr": 48000}
        return session.build_swing_doc(
            "X/swing_001", source,
            {"file": "clip.mp4", "source_start_ms": 0, "source_end_ms": 1000,
             "encoded_start_ms": 0, "width": 1080, "height": 1920},
            {"x": 0, "y": 0, "w": 1080, "h": 1920,
             "space": "source_display", "static": True},
            500,
            [{"file": "frames/frame_0000.jpg", "source_ms": 500,
              "clip_ms": 500, "offset_contact_ms": 0, "pose_score": None,
              "stage": None}],
            measurements=None, objects=objects)

    def errors_for(self, objects):
        from tennisproc import schema
        return schema.validate_swing(self.doc(objects))

    def test_a_racket_without_ball_fields_validates(self):
        self.assertEqual(self.errors_for(
            {"space": "source_display", "detector": "yolo/coco",
             "racket": {"x": 1, "y": 2, "w": 3, "h": 4, "conf": 0.9},
             "ball": None}), [])

    def test_a_ball_with_motion_and_distance_validates(self):
        self.assertEqual(self.errors_for(
            {"space": "source_display", "detector": "yolo/coco",
             "racket": {"x": 1, "y": 2, "w": 3, "h": 4, "conf": 0.9},
             "ball": {"x": 9, "y": 9, "w": 2, "h": 2, "conf": 0.4,
                      "motion": 56.0, "racket_distance": 0.71}}), [])

    def test_both_null_validates(self):
        self.assertEqual(self.errors_for(
            {"space": "source_display", "detector": "yolo/coco",
             "racket": None, "ball": None}), [])

    def test_a_swing_predating_the_block_still_validates(self):
        self.assertEqual(self.errors_for(None), [])

    def test_a_missing_member_is_an_error_not_a_silent_pass(self):
        self.assertTrue(self.errors_for(
            {"space": "source_display", "racket": None}))

    def test_the_wrong_space_is_rejected(self):
        self.assertTrue(self.errors_for(
            {"space": "crop_normalized", "racket": None, "ball": None}))


class ExportRows(unittest.TestCase):
    """The per-frame export format for overlay playback."""

    def rows(self, found):
        import importlib.util
        path = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "scripts", "detect_objects.py")
        spec = importlib.util.spec_from_file_location("detect_objects", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.boxes_to_rows(found)

    def test_boxes_become_x_y_w_h_conf_not_corners(self):
        """A player draws from a width, not a second corner."""
        got = self.rows({"racket": [objects.Box(10, 20, 110, 220, 0.5)],
                         "ball": [], "person": []})
        self.assertEqual(got["racket"], [[10.0, 20.0, 100.0, 200.0, 0.5]])

    def test_empty_classes_are_omitted_not_written_as_empty_lists(self):
        """At native rate this file is 30k lines; empty keys are pure waste."""
        got = self.rows({"racket": [], "ball": [], "person": []})
        self.assertEqual(got, {})


class RacketMotion(unittest.TestCase):
    """Displacement, not presence, is what says a racket was swung.

    Measured against 40 hand-audited candidates of IMG_0684: non-swings peak at
    0.144 torso/frame and real swings sit at a median of 0.365, so the two
    barely overlap. Detection RATE points the other way -- it fell 73% -> 62%
    on a cleaner candidate set, because a swinging racket blurs.
    """

    def frames(self, n=5):
        import numpy as np
        return [(o, np.zeros((400, 400, 3), np.uint8))
                for o in objects.RACKET_OFFSETS[:n]]

    def moving_backend(self, per_frame_px):
        """A racket that slides `per_frame_px` between consecutive samples."""
        script = []
        for k, _ in enumerate(objects.RACKET_OFFSETS):
            # offsets step by 2 frames, so the gap normalisation must divide
            # this displacement by 2 -- the bug this guards is forgetting to.
            x = 100.0 + k * per_frame_px * 2
            script.append({"racket": [objects.Box(x, 100, x + 40, 140, 0.9)],
                           "ball": [], "person": []})
        return objects.StubObjectBackend(script)

    def test_a_swung_racket_clears_the_threshold(self):
        got = objects.racket_motion(self.moving_backend(0.40 * TORSO),
                                    self.frames(), None, [(120, 120)], TORSO)
        self.assertAlmostEqual(got, 0.40, places=2)
        self.assertGreater(got, objects.RACKET_MOVING)

    def test_a_stationary_racket_does_not(self):
        got = objects.racket_motion(self.moving_backend(0.03 * TORSO),
                                    self.frames(), None, [(120, 120)], TORSO)
        self.assertLess(got, objects.RACKET_MOVING)

    def test_displacement_is_per_frame_not_per_sample(self):
        """Offsets step by 2, so a raw difference would read double."""
        got = objects.racket_motion(self.moving_backend(0.20 * TORSO),
                                    self.frames(), None, [(120, 120)], TORSO)
        self.assertAlmostEqual(got, 0.20, places=2)

    def test_fewer_than_two_sightings_is_unknown_not_zero(self):
        """'Never found' must not be reported as 'did not move'."""
        one = objects.StubObjectBackend(
            [{"racket": [objects.Box(100, 100, 140, 140, 0.9)],
              "ball": [], "person": []},
             {"racket": [], "ball": [], "person": []}])
        self.assertIsNone(objects.racket_motion(
            one, self.frames(2), None, [(120, 120)], TORSO))

    def test_measure_reports_motion_and_the_verdict(self):
        import numpy as np
        frame = np.zeros((400, 400, 3), np.uint8)
        doc = objects.measure(self.moving_backend(0.40 * TORSO), frame, frame,
                              None, [(120, 120)], TORSO,
                              neighbours=self.frames())
        self.assertTrue(doc["racket"]["swung"])
        self.assertGreater(doc["racket"]["motion"], objects.RACKET_MOVING)

    def test_without_neighbours_no_verdict_is_offered(self):
        """A single frame cannot show motion, so it must claim nothing."""
        import numpy as np
        frame = np.zeros((400, 400, 3), np.uint8)
        doc = objects.measure(self.moving_backend(0.40 * TORSO), frame, frame,
                              None, [(120, 120)], TORSO)
        self.assertNotIn("swung", doc["racket"])
