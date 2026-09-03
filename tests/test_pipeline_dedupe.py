"""dedupe_swings collapses one swing reported twice, and nothing else.

The cases here are the two populations `Settings.min_gap_s` is sized between:
a stroke whose follow-through was detected as a second swing 1.0-2.0s later,
and two players rallying as fast as 1.0s apart. Time alone cannot tell them
apart -- their gaps overlap -- so every test states the court positions too.
"""

import unittest

from tennisproc import config, pipeline, tracks, verify


def _swing(contact_ms, center_x, speed=40.0, onset_peak=10.0, torso=0.10):
    """One (track, measured) pair, as stage_verify would hand it over."""
    candidate = {"contact_ms": contact_ms, "onset_peak": onset_peak}
    track = tracks.Track(candidate, frames=[])
    measured = verify.Measured(
        0, hitting_side="right", wrist_peak_speed=speed, torso_height=torso,
        contact_offset=0.0, contact_height=0.0, peak_ms=contact_ms,
        center_x=center_x, contact_ms=contact_ms)
    return track, measured


def _contacts(kept):
    return [measured.contact_ms for _, measured in kept]


DEFAULTS = config.Settings()


def _dedupe(accepted, gap_s=None, torsos=None):
    return pipeline.dedupe_swings(
        accepted,
        DEFAULTS.min_gap_s if gap_s is None else gap_s,
        DEFAULTS.same_place_torsos if torsos is None else torsos)


class DedupeSwings(unittest.TestCase):

    def test_no_swings_is_not_an_error(self):
        self.assertEqual(pipeline.dedupe_swings([], 2.0, 2.0), [])

    def test_one_stroke_detected_twice_ships_once(self):
        # IMG_0684 at 28.55s and 29.90s: the second "contact" is the player
        # standing with the racket at his chest, 1.35s after the serve.
        kept = _dedupe([_swing(28550, 0.40, onset_peak=52.0),
                        _swing(29900, 0.42, onset_peak=9.0)])
        self.assertEqual(_contacts(kept), [28550])

    def test_two_players_a_second_apart_both_ship(self):
        # The 84 cross-slot pairs under 2.5s apart in out/ separate by at
        # least 2.12 torso heights and by 6.34 at the median. These two are
        # 4 torso heights apart, which is an ordinary rally exchange.
        kept = _dedupe([_swing(60000, 0.20), _swing(61000, 0.60)])
        self.assertEqual(_contacts(kept), [60000, 61000])

    def test_the_same_player_at_the_far_end_still_counts_as_one_place(self):
        """Position is in torso heights, not frame fractions.

        A distant player is small, so a fixed frame-fraction test would call
        his own two-frame drift a second person. Same absolute drift, half the
        torso: still one place.
        """
        near = _dedupe([_swing(60000, 0.40, torso=0.10),
                        _swing(61300, 0.55, torso=0.10)])
        far = _dedupe([_swing(60000, 0.40, torso=0.05),
                       _swing(61300, 0.475, torso=0.05)])
        self.assertEqual(len(near), 1)
        self.assertEqual(len(far), 1)

    def test_a_real_repeat_by_one_player_survives(self):
        # The shortest same-player repeat measured over out/ is 2.53s.
        kept = _dedupe([_swing(60000, 0.40), _swing(62530, 0.40)])
        self.assertEqual(_contacts(kept), [60000, 62530])

    def test_the_louder_strike_is_the_one_kept(self):
        """A racket strike is the loudest thing in its second.

        The duplicate is anchored on whatever else was audible, so it is
        quieter -- whichever side of the real swing it landed.
        """
        after = _dedupe([_swing(60000, 0.40, onset_peak=48.0),
                         _swing(61300, 0.40, onset_peak=9.5)])
        before = _dedupe([_swing(60000, 0.40, onset_peak=9.5),
                          _swing(61300, 0.40, onset_peak=48.0)])
        self.assertEqual(_contacts(after), [60000])
        self.assertEqual(_contacts(before), [61300])

    def test_capped_wrist_speeds_no_longer_decide_the_pair(self):
        """The regression this rule was written for.

        `verify.SPEED_CAP` clips peak speed at 40.0 and 63% of shipped swings
        sit exactly on it, so the old keep-the-fastest rule could not choose
        between these two at all and kept whichever arrived first.
        """
        capped = verify.SPEED_CAP
        kept = _dedupe([_swing(60000, 0.40, speed=capped, onset_peak=8.1),
                        _swing(61300, 0.40, speed=capped, onset_peak=44.0)])
        self.assertEqual(_contacts(kept), [61300])

    def test_wrist_speed_still_decides_when_no_onset_strength_exists(self):
        """A detector run without onset strengths must still choose."""
        kept = _dedupe([_swing(60000, 0.40, speed=12.0, onset_peak=None),
                        _swing(61300, 0.40, speed=31.0, onset_peak=None)])
        self.assertEqual(_contacts(kept), [61300])

    def test_an_unmeasurable_position_keeps_both_swings(self):
        """Shipping a duplicate beats deleting a real swing.

        Nothing on the accepted path leaves center_x unset, but if that ever
        changes the failure has to be the harmless one.
        """
        a = _swing(60000, 0.40)
        b = _swing(61300, 0.40)
        b[1].center_x = None
        self.assertEqual(len(_dedupe([a, b])), 2)

    def test_a_zero_torso_keeps_both_swings(self):
        # No torso height means no scale to measure the separation in.
        a = _swing(60000, 0.40, torso=0.0)
        b = _swing(61300, 0.40, torso=0.0)
        self.assertEqual(len(_dedupe([a, b])), 2)

    def test_three_detections_of_one_stroke_collapse_to_the_loudest(self):
        kept = _dedupe([_swing(60000, 0.40, onset_peak=11.0),
                        _swing(61100, 0.41, onset_peak=51.0),
                        _swing(62300, 0.42, onset_peak=8.0)])
        self.assertEqual(_contacts(kept), [61100])

    def test_swings_are_ordered_by_the_anchored_contact(self):
        """The caller's order is not the timeline.

        stage_verify preserves candidate order, and a re-anchored swing can
        move; comparing neighbours in the wrong order compares the wrong pair.
        """
        kept = _dedupe([_swing(62530, 0.40), _swing(60000, 0.40)])
        self.assertEqual(_contacts(kept), [60000, 62530])

    def test_a_track_contact_stands_in_when_pose_measured_none(self):
        track, measured = _swing(60000, 0.40)
        measured.contact_ms = None
        kept = _dedupe([(track, measured), _swing(60800, 0.40,
                                                 onset_peak=4.0)])
        self.assertEqual(len(kept), 1)

    def test_the_defaults_collapse_the_pair_the_user_reported(self):
        """End to end on the shipped defaults, not on hand-passed numbers."""
        kept = pipeline.dedupe_swings(
            [_swing(175000, 0.40, onset_peak=40.0),
             _swing(176300, 0.41, onset_peak=9.0)],
            DEFAULTS.min_gap_s, DEFAULTS.same_place_torsos)
        self.assertEqual(_contacts(kept), [175000])


if __name__ == "__main__":
    unittest.main()


class TestKeepsTheStrikeInFrame(unittest.TestCase):
    """The tiebreak is chosen for coverage, not for label accuracy.

    Which member of a collapsed pair is the real strike cannot be decided from
    what the pipeline measures -- every candidate signal scores between 50% and
    61% over the feed-slot collisions, which at that sample size is a coin
    flip. So the rule is built to keep the strike ON SCREEN whichever member it
    was, because that is what a reviewer actually judges.
    """

    def test_keeps_the_earlier_when_the_later_would_clip_it(self):
        # 1.8s apart, wider than pre_s: the later member's window starts at
        # its own contact minus 1.5s, which is AFTER the earlier contact. Were
        # it kept, and were the earlier one the real strike, the clip would not
        # contain the strike at all.
        early = _swing(contact_ms=10_000, onset_peak=1.0, center_x=0.5)
        late = _swing(contact_ms=11_800, onset_peak=99.0, center_x=0.5)
        kept = pipeline.dedupe_swings([early, late], min_gap_s=2.0,
                                      same_place_torsos=2.0, pre_s=1.5)
        assert len(kept) == 1
        # Kept the earlier DESPITE the later's far louder onset.
        assert kept[0][1].contact_ms == 10_000

    def test_confidence_still_decides_when_either_window_covers_both(self):
        # 1.2s apart: both windows contain both contacts, so nothing is lost
        # either way and the louder onset is free to win.
        early = _swing(contact_ms=10_000, onset_peak=1.0, center_x=0.5)
        late = _swing(contact_ms=11_200, onset_peak=99.0, center_x=0.5)
        kept = pipeline.dedupe_swings([early, late], min_gap_s=2.0,
                                      same_place_torsos=2.0, pre_s=1.5)
        assert len(kept) == 1
        assert kept[0][1].contact_ms == 11_200

    def test_every_collapsed_pair_leaves_the_other_contact_in_frame(self):
        # The property the rule exists to guarantee, over the whole range
        # dedupe fires in.
        for gap_ms in range(1000, 2000, 50):
            a = _swing(contact_ms=10_000, onset_peak=1.0, center_x=0.5)
            b = _swing(contact_ms=10_000 + gap_ms, onset_peak=99.0, center_x=0.5)
            kept = pipeline.dedupe_swings([a, b], min_gap_s=2.0,
                                          same_place_torsos=2.0, pre_s=1.5)
            assert len(kept) == 1
            anchor = kept[0][1].contact_ms
            start, end = anchor - 1500, anchor + 2000
            for other in (10_000, 10_000 + gap_ms):
                assert start <= other <= end, (
                    "gap %dms: contact %d falls outside the kept window "
                    "%d-%d" % (gap_ms, other, start, end))
