"""The vision detector: swing peaks, audio corroboration, identity flips."""

import unittest

from tennisproc import scan


def body(ms, x, wrist_x=None, torso=0.10):
    wrist = x if wrist_x is None else wrist_x
    return {"ms": ms, "lw": (wrist, 0.5), "rw": (wrist, 0.5),
            "torso": torso, "cx": x}


class WristSpeedSeries(unittest.TestCase):

    def test_measures_one_body_swinging(self):
        samples = [body(i * 100, 0.30, wrist_x=0.30 + 0.02 * i) for i in range(5)]
        speeds = scan.wrist_speed_series(samples)
        self.assertEqual([t for t, _ in speeds], [100, 200, 300])
        self.assertAlmostEqual(speeds[0][1], 2.0, places=3)

    def test_refuses_to_measure_across_an_identity_flip(self):
        """A flip between two players is the fastest thing in a session.

        Measured before this guard: a near player at x=0.30 and a far one at
        x=0.72 with a single flipped frame produced 17.5 torso-heights/s,
        against 8.25 for the strongest genuine swing -- so every flip both
        invented a candidate and, through greedy thinning, suppressed the real
        swings within a second of it.
        """
        samples = [body(0, 0.30), body(100, 0.30), body(200, 0.72),
                   body(300, 0.30), body(400, 0.30)]
        self.assertEqual(scan.wrist_speed_series(samples), [])

    def test_a_cache_without_centres_still_measures(self):
        """`cx` postdates the first scans; their caches must not break."""
        samples = [{k: v for k, v in body(i * 100, 0.30,
                                          wrist_x=0.30 + 0.02 * i).items()
                    if k != "cx"} for i in range(5)]
        self.assertEqual(len(scan.wrist_speed_series(samples)), 3)

    def test_a_body_walking_is_not_a_flip(self):
        """Real movement between samples stays under the jump threshold."""
        samples = [body(i * 100, 0.30 + 0.02 * i) for i in range(5)]
        self.assertEqual(len(scan.wrist_speed_series(samples)), 3)


class FindPeaks(unittest.TestCase):

    def test_no_series_no_peaks(self):
        self.assertEqual(scan.find_peaks([]), [])

    def test_keeps_the_faster_sample_of_one_stroke(self):
        series = [(0, 0.1), (100, 0.1), (200, 5.0), (300, 9.0), (400, 0.1)]
        peaks = scan.find_peaks(series, k=1.0, min_gap_s=1.0)
        self.assertEqual([t for t, _ in peaks], [300])


class Corroborate(unittest.TestCase):

    def test_a_peak_with_no_strike_is_dropped(self):
        peaks = [(1000, 9.0)]
        self.assertEqual(scan.corroborate(peaks, [{"contact_ms": 9000}]), [])

    def test_a_peak_takes_the_timestamp_of_its_strike(self):
        peaks = [(1000, 9.0)]
        onsets = [{"contact_ms": 1180, "onset_peak": 31.0}]
        got = scan.corroborate(peaks, onsets)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["contact_ms"], 1180)
        self.assertEqual(got[0]["onset_peak"], 31.0)
        self.assertEqual(got[0]["scan_ms"], 1000)

    def test_no_onsets_at_all_yields_nothing(self):
        self.assertEqual(scan.corroborate([(1000, 9.0)], []), [])


class Cache(unittest.TestCase):

    def test_a_cache_written_with_other_settings_is_ignored(self):
        import tempfile, os
        path = os.path.join(tempfile.mkdtemp(), "scan.jsonl.gz")
        scan.write_cache(path, [body(0, 0.3)], "hash-a")
        self.assertIsNone(scan.read_cache(path, "hash-b"))
        self.assertEqual(len(scan.read_cache(path, "hash-a")), 1)

    def test_a_truncated_cache_reads_as_absent(self):
        """Killing a run mid-write left a torn file that crashed every later
        one: gzip raises EOFError, which is not an OSError."""
        import tempfile, os
        path = os.path.join(tempfile.mkdtemp(), "scan.jsonl.gz")
        scan.write_cache(path, [body(0, 0.3), body(100, 0.3)], "hash-a")
        with open(path, "rb") as fh:
            data = fh.read()
        with open(path, "wb") as fh:
            fh.write(data[:len(data) // 2])
        self.assertIsNone(scan.read_cache(path, "hash-a"))


if __name__ == "__main__":
    unittest.main()
