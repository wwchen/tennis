"""Detection recall against real session footage.

Every other test in this suite uses synthesized fixtures, which can show that
the code is self-consistent but not that it finds actual tennis shots. This
file is the only check of recall on real video, and it is what caught the
min_gap_s default being wrong twice.

Ground truth is `tests/fixtures/known_shots.json`: 354 pose-verified shot
times from the previous generation of this project, reviewed against real
video. Imperfect -- that pipeline had a known wrist-selection bug -- but it
affected stroke labels, not shot times, which is all this uses.

Tests skip when the videos themselves are absent, so a clean checkout still
passes. The videos are ~4 GB and live outside the repository.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import audio, config

TOLERANCE_S = 0.15
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "known_shots.json")


REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _find_video(recorded_path, stem):
    """The video for a session, wherever it actually is now.

    The fixture records the absolute path the ground truth was collected
    against -- `~/Downloads/IMG_0304.MOV`. Footage moved into `raw/` inside the
    repository and the recorded path stopped existing, so `sessions()` returned
    nothing and this entire class skipped. Silently: the suite still reported
    OK, four skips look like the four the README budgets for, and the only
    measurement of recall in the project was gone for as long as nobody
    counted. Two detector defaults were then changed with no recall check at
    all, one of which cost a third of the shots in a session.

    So the recorded path is a hint, not the answer: fall back to `raw/<stem>`
    beside the repo, which is where the videos live now.
    """
    recorded = os.path.expanduser(recorded_path or "")
    if recorded and os.path.exists(recorded):
        return recorded
    for ext in (".MOV", ".mov", ".mp4", ".MP4"):
        candidate = os.path.join(REPO, "raw", stem + ext)
        if os.path.exists(candidate):
            return candidate
    return None


def sessions():
    """[(stem, video_path, [verified_times_s])] for videos present on disk."""
    try:
        with open(FIXTURE, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    out = []
    for stem, entry in sorted(data.get("sessions", {}).items()):
        video = _find_video(entry.get("video"), stem)
        times = entry.get("verified_times_s") or []
        if video and len(times) >= 10:
            out.append((stem, video, sorted(times)))
    return out


AVAILABLE = sessions()


def recall(found_s, truth_s, tolerance=TOLERANCE_S):
    hits = sum(1 for t in truth_s
               if any(abs(t - f) < tolerance for f in found_s))
    return hits / float(len(truth_s))


@unittest.skipUnless(AVAILABLE, "no real footage + shots.json available")
class TestRecallOnRealFootage(unittest.TestCase):
    def detect(self, video, settings):
        found = audio.collapse(audio.detect(video, k=settings.onset_k),
                               settings.min_gap_s)
        return [c["contact_ms"] / 1000.0 for c in found]

    def test_defaults_find_almost_every_known_shot(self):
        for stem, video, truth in AVAILABLE:
            with self.subTest(session=stem):
                got = recall(self.detect(video, config.Settings()), truth)
                self.assertGreaterEqual(
                    got, 0.95,
                    "%s: recall %.0f%% of %d known shots"
                    % (stem, 100 * got, len(truth)))

    def test_the_gap_setting_is_what_costs_recall(self):
        """Proof the collapse step, not the detector, is the risk.

        The detector finds ~99% of known shots; a too-large --gap is what
        throws them away. This is why the default is 0.12s.
        """
        stem, video, truth = AVAILABLE[0]
        tight = config.Settings(min_gap_s=0.12)
        loose = config.Settings(min_gap_s=1.0)
        self.assertGreater(recall(self.detect(video, tight), truth),
                           recall(self.detect(video, loose), truth))

    def test_real_shots_can_be_closer_together_than_intuition_suggests(self):
        """Sanity-check the number the default is derived from."""
        closest = min(b - a
                      for _, _, truth in AVAILABLE
                      for a, b in zip(truth, truth[1:]))
        self.assertLess(closest, 0.35,
                        "if no real pair is under 0.35s, the measured basis "
                        "for min_gap_s no longer holds")
        self.assertGreaterEqual(config.Settings().min_gap_s, 0.0)
        self.assertLessEqual(config.Settings().min_gap_s, closest + 0.01)

    def test_portrait_footage_probes_as_portrait(self):
        """Real iPhone .MOV files are the rotation case that matters."""
        from tennisproc import probe
        for stem, video, _ in AVAILABLE:
            with self.subTest(session=stem):
                source = probe.probe(video)
                self.assertTrue(source["has_audio"])
                if source["rotation"] in (90, 270):
                    self.assertGreater(source["height"], source["width"],
                                       "%s: rotated source should be "
                                       "portrait after the dimension swap"
                                       % stem)


if __name__ == "__main__":
    unittest.main()
