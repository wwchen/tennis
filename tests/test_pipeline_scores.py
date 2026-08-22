"""_attach_pose_scores keeps the frames block and measurements consistent."""

import unittest

from tennisproc import pipeline, schema


class _Sample(object):
    def __init__(self, score):
        self.score = score


class _Track(object):
    """Just enough of a track to drive _attach_pose_scores."""

    def __init__(self, rows):
        self._rows = rows

    def series(self, slot):
        return self._rows


def _frames(*offsets_ms):
    contact = 10000
    return [schema.new_frame("frame_%04d.jpg" % i, contact + off, 0, off)
            for i, off in enumerate(offsets_ms)]


class AttachPoseScores(unittest.TestCase):

    def test_native_fps_scores_only_frames_inside_the_window(self):
        # 33 ms stills: every one within 50 ms of the sample takes its score,
        # the rest stay None, which is what the docstring has always promised.
        frames = _frames(-66, -33, 0, 33, 66)
        track = _Track([(10000, _Sample(0.91))])
        pipeline._attach_pose_scores(frames, track, "left")
        self.assertEqual([f["pose_score"] for f in frames],
                         [None, 0.91, 0.91, 0.91, None])

    def test_coarse_fps_still_scores_the_frame_nearest_the_track(self):
        # --fps 2: every still is >50 ms from the only pose sample, so the
        # 50 ms rule scores nothing and the document would fail the schema.
        frames = _frames(-1000, -500, 0, 500, 1000)
        track = _Track([(10120, _Sample(0.77))])
        pipeline._attach_pose_scores(frames, track, "left")
        scores = [f["pose_score"] for f in frames]
        self.assertEqual(scores, [None, None, 0.77, None, None])

    def test_the_adopted_frame_is_the_closest_one_not_merely_the_first(self):
        frames = _frames(-1000, -500, 0, 500, 1000)
        track = _Track([(10900, _Sample(0.64))])
        pipeline._attach_pose_scores(frames, track, "left")
        self.assertEqual([f["pose_score"] for f in frames],
                         [None, None, None, None, 0.64])

    def test_no_track_leaves_every_frame_unscored(self):
        # measurements is null in this case too, so the schema stays happy.
        frames = _frames(-500, 0, 500)
        pipeline._attach_pose_scores(frames, _Track([]), "left")
        self.assertEqual([f["pose_score"] for f in frames], [None, None, None])

    def test_a_coarse_grid_document_passes_the_schema(self):
        # The end the fix exists for: a swing with measurements and 0.5 s
        # stills validates instead of aborting the session.
        frames = _frames(-1500, -1000, -500, 0, 500, 1000, 1500)
        pipeline._attach_pose_scores(frames, _Track([(10130, _Sample(0.8))]), "left")
        self.assertTrue(any(f["pose_score"] is not None for f in frames))


if __name__ == "__main__":
    unittest.main()
