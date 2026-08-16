"""Tests for player zone assignment and crop geometry."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import crop, players, schema, verify


def measured(center_x=0.5, torso=0.12, speed=2.0):
    return verify.Measured(0, hitting_side="right", wrist_peak_speed=speed,
                           torso_height=torso, contact_offset=0.5,
                           contact_height=-0.1, peak_ms=1000,
                           center_x=center_x)


class TestWidestGap(unittest.TestCase):
    def test_splits_two_clusters(self):
        values = [0.2, 0.22, 0.25, 0.7, 0.72, 0.75]
        boundary = players.widest_gap(values)
        self.assertGreater(boundary, 0.25)
        self.assertLess(boundary, 0.7)

    def test_returns_the_true_widest_gap_including_to_an_outlier(self):
        """widest_gap is purely geometric; assign() judges whether it means
        anything. An earlier version searched only the middle half to dodge
        outliers, which also hid the real boundary when two players took very
        unequal numbers of swings."""
        values = [0.01, 0.40, 0.42, 0.44, 0.46, 0.70, 0.72, 0.74]
        boundary = players.widest_gap(values)
        self.assertGreater(boundary, 0.01)
        self.assertLess(boundary, 0.40)

    def test_finds_a_boundary_outside_the_middle_half(self):
        """15 swings then 4: the jump sits at index 15 of 19."""
        values = [0.20 + 0.01 * i for i in range(15)] + [
            0.80 + 0.01 * i for i in range(4)]
        boundary = players.widest_gap(values)
        self.assertGreater(boundary, 0.34)
        self.assertLess(boundary, 0.80)

    def test_gap_stats_reports_the_ratio_that_decides_a_split(self):
        two = [0.20 + 0.01 * i for i in range(10)] + [
            0.75 + 0.01 * i for i in range(10)]
        _, gap, median_gap = players.gap_stats(two)
        self.assertGreater(gap, median_gap * players.GAP_RATIO)

        one = [0.50 + 0.01 * i for i in range(20)]
        _, gap, median_gap = players.gap_stats(one)
        self.assertLessEqual(gap, median_gap * players.GAP_RATIO)

    def test_too_few_values(self):
        self.assertIsNone(players.widest_gap([]))
        self.assertIsNone(players.widest_gap([0.5]))

    def test_identical_values(self):
        self.assertIsNotNone(players.widest_gap([0.5] * 6))


class TestAssign(unittest.TestCase):
    def test_two_clusters_become_left_and_right(self):
        swings = ([measured(center_x=0.2 + 0.01 * i) for i in range(6)]
                  + [measured(center_x=0.75 + 0.01 * i) for i in range(6)])
        slots, info = players.assign(swings, mode=players.SIDE)
        self.assertEqual(info["count"], 2)
        self.assertEqual(slots[:6], ["left"] * 6)
        self.assertEqual(slots[6:], ["right"] * 6)

    def test_one_cluster_stays_one_player(self):
        swings = [measured(center_x=0.5 + 0.005 * i) for i in range(10)]
        slots, info = players.assign(swings, mode=players.SIDE)
        self.assertEqual(info["count"], 1)
        self.assertEqual(set(slots), {"left"})

    def test_forcing_one_player_disables_splitting(self):
        swings = ([measured(center_x=0.2) for _ in range(6)]
                  + [measured(center_x=0.8) for _ in range(6)])
        slots, info = players.assign(swings, mode=players.SIDE, count=1)
        self.assertEqual(info["count"], 1)
        self.assertEqual(set(slots), {"left"})

    def test_depth_mode_uses_body_size(self):
        """A nearer player has a bigger torso."""
        swings = ([measured(torso=0.08 + 0.001 * i) for i in range(6)]
                  + [measured(torso=0.20 + 0.001 * i) for i in range(6)])
        slots, info = players.assign(swings, mode=players.DEPTH)
        self.assertEqual(info["mode"], "depth")
        self.assertEqual(info["count"], 2)
        self.assertEqual(slots[0], "far")
        self.assertEqual(slots[-1], "near")

    def test_zone_swing_counts_add_up(self):
        swings = ([measured(center_x=0.2) for _ in range(4)]
                  + [measured(center_x=0.8) for _ in range(7)])
        _, info = players.assign(swings)
        self.assertEqual(sum(z["swings"] for z in info["zones"]), 11)

    def test_lopsided_split_is_rejected(self):
        """One stray swing across the court is not a second player."""
        swings = [measured(center_x=0.5 + 0.002 * i) for i in range(30)]
        swings.append(measured(center_x=0.95))
        _, info = players.assign(swings)
        self.assertEqual(info["count"], 1)

    def test_two_strays_are_still_not_a_player(self):
        swings = [measured(center_x=0.5 + 0.002 * i) for i in range(25)]
        swings += [measured(center_x=0.95), measured(center_x=0.96)]
        _, info = players.assign(swings)
        self.assertEqual(info["count"], 1)

    def test_unequal_but_real_second_player_is_found(self):
        """A partner who only took 4 of 19 swings is still a partner.

        This failed before: the boundary search skipped gaps outside the
        middle half, so the jump at index 15 of 19 was never examined.
        """
        swings = ([measured(center_x=0.20 + 0.01 * i) for i in range(15)]
                  + [measured(center_x=0.80 + 0.01 * i) for i in range(4)])
        slots, info = players.assign(swings)
        self.assertEqual(info["count"], 2)
        self.assertEqual(slots[:15], ["left"] * 15)
        self.assertEqual(slots[15:], ["right"] * 4)

    def test_evenly_spread_single_player_is_not_split(self):
        """No gap stands out from the typical spacing, so it is one player."""
        swings = [measured(center_x=0.30 + 0.02 * i) for i in range(20)]
        _, info = players.assign(swings)
        self.assertEqual(info["count"], 1)

    def test_too_few_swings_to_split(self):
        slots, info = players.assign([measured(center_x=0.2),
                                      measured(center_x=0.8)])
        self.assertEqual(info["count"], 1)
        self.assertEqual(len(slots), 2)

    def test_empty_input(self):
        slots, info = players.assign([])
        self.assertEqual(slots, [])
        self.assertEqual(info["count"], 0)
        self.assertEqual(info["zones"], [])

    def test_slots_are_schema_enums(self):
        swings = ([measured(center_x=0.2) for _ in range(6)]
                  + [measured(center_x=0.8) for _ in range(6)])
        for mode in (players.SIDE, players.DEPTH):
            data = (swings if mode == players.SIDE
                    else [measured(torso=0.08) for _ in range(6)]
                    + [measured(torso=0.2) for _ in range(6)])
            slots, info = players.assign(data, mode=mode)
            for slot in slots:
                self.assertIn(slot, schema.PLAYER_SLOTS)
            self.assertIn(info["mode"], schema.PLAYER_MODES)

    def test_info_block_validates_in_a_session_doc(self):
        swings = ([measured(center_x=0.2) for _ in range(6)]
                  + [measured(center_x=0.8) for _ in range(6)])
        _, info = players.assign(swings)
        errors = schema.validate_session({"players": info})
        self.assertFalse([e for e in errors if e.startswith("players")], errors)

    def test_slots_are_parallel_to_input(self):
        swings = [measured(center_x=0.2), measured(center_x=0.8),
                  measured(center_x=0.21), measured(center_x=0.79),
                  measured(center_x=0.22), measured(center_x=0.78)]
        slots, _ = players.assign(swings)
        self.assertEqual(len(slots), len(swings))
        self.assertEqual(slots[0], slots[2])
        self.assertEqual(slots[1], slots[3])
        self.assertNotEqual(slots[0], slots[1])


class TestUnionAndPad(unittest.TestCase):
    def test_union_covers_every_box(self):
        got = crop.union([(0.2, 0.3, 0.4, 0.5), (0.35, 0.1, 0.6, 0.45)])
        self.assertEqual(got, (0.2, 0.1, 0.6, 0.5))

    def test_union_of_one(self):
        self.assertEqual(crop.union([(0.1, 0.2, 0.3, 0.4)]),
                         (0.1, 0.2, 0.3, 0.4))

    def test_union_of_none(self):
        self.assertIsNone(crop.union([]))

    def test_pad_grows_all_sides(self):
        x0, y0, x1, y1 = crop.pad((0.4, 0.4, 0.6, 0.6), 0.5)
        self.assertLess(x0, 0.4)
        self.assertLess(y0, 0.4)
        self.assertGreater(x1, 0.6)
        self.assertGreater(y1, 0.6)

    def test_pad_uses_the_larger_dimension(self):
        """A tall thin box must not get a mean horizontal margin."""
        box = (0.45, 0.10, 0.55, 0.90)
        x0, y0, x1, y1 = crop.pad(box, 0.25)
        self.assertAlmostEqual((0.45 - x0), (0.10 - y0), places=6)

    def test_zero_pad_is_identity(self):
        box = (0.1, 0.2, 0.3, 0.4)
        self.assertEqual(crop.pad(box, 0.0), box)


class TestToPixels(unittest.TestCase):
    def test_converts_and_rounds(self):
        got = crop.to_pixels((0.25, 0.5, 0.75, 1.0), 1000, 500)
        self.assertEqual(got["x"], 250)
        self.assertEqual(got["w"], 500)
        self.assertEqual(got["h"], 250)

    def test_dimensions_are_even(self):
        """H.264 with yuv420p cannot encode odd sizes."""
        for w, h in ((999, 501), (1001, 499), (333, 777)):
            got = crop.to_pixels((0.0, 0.0, 0.333, 0.333), w, h)
            self.assertEqual(got["w"] % 2, 0)
            self.assertEqual(got["h"] % 2, 0)

    def test_clamps_inside_the_frame(self):
        got = crop.to_pixels((-0.5, -0.5, 1.5, 1.5), 640, 480)
        self.assertGreaterEqual(got["x"], 0)
        self.assertGreaterEqual(got["y"], 0)
        self.assertLessEqual(got["x"] + got["w"], 640)
        self.assertLessEqual(got["y"] + got["h"], 480)

    def test_slides_rather_than_shrinks_at_an_edge(self):
        """A player at the frame edge should stay whole, not get cut down."""
        got = crop.to_pixels((0.9, 0.9, 1.2, 1.2), 1000, 1000)
        self.assertEqual(got["w"], 300)
        self.assertEqual(got["x"] + got["w"], 1000)

    def test_enforces_a_minimum_size(self):
        got = crop.to_pixels((0.5, 0.5, 0.501, 0.501), 1000, 1000,
                             min_size=64)
        self.assertGreaterEqual(got["w"], 64)
        self.assertGreaterEqual(got["h"], 64)

    def test_box_larger_than_frame_becomes_the_frame(self):
        got = crop.to_pixels((0.0, 0.0, 2.0, 2.0), 640, 480)
        self.assertEqual((got["w"], got["h"]), (640, 480))
        self.assertEqual((got["x"], got["y"]), (0, 0))


class TestRectFor(unittest.TestCase):
    def test_produces_a_valid_crop_block(self):
        rect = crop.rect_for([(0.4, 0.3, 0.6, 0.7)], 1080, 1920)
        errors = schema.validate_swing({"crop": rect})
        self.assertFalse([e for e in errors if e.startswith("crop")], errors)

    def test_covers_the_whole_swing(self):
        """The crop must contain every frame's box, not just one."""
        boxes = [(0.30, 0.3, 0.45, 0.7), (0.55, 0.3, 0.70, 0.7)]
        rect = crop.rect_for(boxes, 1000, 1000, pad_fraction=0.0)
        self.assertLessEqual(rect["x"], 300)
        self.assertGreaterEqual(rect["x"] + rect["w"], 700)

    def test_falls_back_to_the_whole_frame_without_pose(self):
        rect = crop.rect_for([], 640, 480)
        self.assertEqual((rect["x"], rect["y"], rect["w"], rect["h"]),
                         (0, 0, 640, 480))

    def test_portrait_frame_geometry(self):
        """The iPhone case: 1080x1920 display dimensions."""
        rect = crop.rect_for([(0.35, 0.20, 0.65, 0.60)], 1080, 1920)
        self.assertLessEqual(rect["x"] + rect["w"], 1080)
        self.assertLessEqual(rect["y"] + rect["h"], 1920)


class TestScaleToLongEdge(unittest.TestCase):
    def test_scales_landscape_by_width(self):
        self.assertEqual(crop.scale_to_long_edge(1920, 1080, 640), (640, 360))

    def test_scales_portrait_by_height(self):
        w, h = crop.scale_to_long_edge(1080, 1920, 640)
        self.assertEqual(h, 640)
        self.assertEqual(w, 360)

    def test_never_upscales(self):
        self.assertEqual(crop.scale_to_long_edge(320, 240, 640), (320, 240))

    def test_both_dimensions_even(self):
        for size in ((1001, 667), (333, 999), (517, 289)):
            w, h = crop.scale_to_long_edge(*size, 640)
            self.assertEqual(w % 2, 0)
            self.assertEqual(h % 2, 0)

    def test_zero_long_edge_keeps_size(self):
        self.assertEqual(crop.scale_to_long_edge(300, 200, 0), (300, 200))

    def test_aspect_ratio_is_preserved(self):
        w, h = crop.scale_to_long_edge(1600, 900, 640)
        self.assertAlmostEqual(w / h, 1600 / 900, delta=0.02)


if __name__ == "__main__":
    unittest.main()
