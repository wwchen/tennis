"""Tests for audio onset detection, against synthesized clicks at known times."""

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

from tennisproc import audio

HAVE_FFMPEG = bool(shutil.which("ffmpeg"))
SR = audio.SAMPLE_RATE


def clicks(times_s, duration_s=10.0, sr=SR, noise=0.005, amplitude=0.8,
           decay_s=0.004, seed=0):
    """A noise floor with sharp broadband transients at the given times.

    `amplitude` may be a scalar or one value per time, so a mixed-loudness
    session can be built in a single array. Summing two clicks() results
    would sum their noise floors too, which shifts the threshold.
    """
    rng = np.random.default_rng(seed)
    n = int(duration_s * sr)
    x = rng.normal(0.0, noise, n).astype(np.float32)
    span = int(decay_s * sr)
    env = np.exp(-np.linspace(0.0, 6.0, span)).astype(np.float32)
    amps = ([amplitude] * len(times_s) if np.isscalar(amplitude)
            else list(amplitude))
    for t, amp in zip(times_s, amps):
        start = int(t * sr)
        burst = rng.normal(0.0, 1.0, span).astype(np.float32) * env * amp
        x[start:start + span] += burst[:max(0, min(span, n - start))]
    return np.clip(x, -1.0, 1.0)


def write_wav(path, samples, sr=SR):
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((samples * 32767).astype("<i2").tobytes())
    return path


def found_ms(result):
    return [c["contact_ms"] for c in result]


class TestFindOnsets(unittest.TestCase):
    def assert_matches(self, result, expected_s, tol_ms=30):
        got = found_ms(result)
        self.assertEqual(len(got), len(expected_s),
                         "expected %d onsets at %s, got %s"
                         % (len(expected_s), expected_s, got))
        for ms, want in zip(got, expected_s):
            self.assertLess(abs(ms - want * 1000), tol_ms,
                            "onset %dms is not within %dms of %.2fs"
                            % (ms, tol_ms, want))

    def test_finds_single_click_at_the_right_time(self):
        x = clicks([3.0])
        self.assert_matches(audio.find_onsets(x, SR), [3.0])

    def test_finds_several_clicks(self):
        times = [1.0, 2.5, 4.0, 7.25]
        self.assert_matches(audio.find_onsets(clicks(times), SR), times)

    def test_timing_accuracy_is_within_a_video_frame(self):
        """The whole reason audio drives detection: better than 33ms."""
        for t in (1.234, 5.678, 8.5):
            got = found_ms(audio.find_onsets(clicks([t]), SR))
            self.assertEqual(len(got), 1)
            self.assertLess(abs(got[0] - t * 1000), 33,
                            "%.3fs -> %dms is off by a frame or more"
                            % (t, got[0]))

    def test_silence_yields_nothing(self):
        self.assertEqual(audio.find_onsets(np.zeros(SR * 3, np.float32), SR),
                         [])

    def test_pure_noise_yields_nothing(self):
        rng = np.random.default_rng(1)
        x = rng.normal(0, 0.01, SR * 5).astype(np.float32)
        self.assertEqual(audio.find_onsets(x, SR, k=8.0), [])

    def test_steady_tone_is_not_an_onset(self):
        """A sine has no transient; only its onset edge could qualify."""
        t = np.arange(SR * 5) / SR
        x = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        self.assertEqual(audio.find_onsets(x, SR, k=8.0), [])

    def test_empty_and_tiny_input(self):
        self.assertEqual(audio.find_onsets(np.zeros(0, np.float32), SR), [])
        self.assertEqual(audio.find_onsets(np.zeros(1, np.float32), SR), [])

    def test_refractory_merges_a_double_bounce(self):
        """A strike plus its immediate echo is one shot, not two."""
        got = audio.find_onsets(clicks([3.0, 3.05]), SR)
        self.assertEqual(len(got), 1, found_ms(got))

    def test_refractory_keeps_genuinely_separate_shots(self):
        got = audio.find_onsets(clicks([3.0, 3.4]), SR)
        self.assertEqual(len(got), 2, found_ms(got))

    def test_k_trades_recall_for_precision(self):
        """A soft third hit survives a moderate k and is lost at a harsh one.

        This is the knob `detect --dry-run` exists to sweep: too high and
        quiet shots vanish, too low and the noise floor itself detects.
        """
        x = clicks([2.0, 3.5, 5.0], amplitude=[0.9, 0.06, 0.9])
        self.assertEqual(len(audio.find_onsets(x, SR, k=8.0)), 3)
        self.assertEqual(len(audio.find_onsets(x, SR, k=60.0)), 2)

    def test_very_low_k_detects_the_noise_floor(self):
        """The failure mode at the other end, made explicit."""
        x = clicks([2.0, 5.0], amplitude=0.9)
        self.assertGreater(len(audio.find_onsets(x, SR, k=2.0)), 10)

    def test_onset_peak_is_gain_invariant(self):
        """Same recording twice as loud must report a similar peak strength."""
        x = clicks([3.0])
        quiet = audio.find_onsets(x * 0.25, SR)
        loud = audio.find_onsets(x * 1.0, SR)
        self.assertEqual(len(quiet), len(loud), 1)
        self.assertLess(abs(quiet[0]["onset_peak"] - loud[0]["onset_peak"]),
                        0.35 * loud[0]["onset_peak"])

    def test_onset_peak_ranks_a_hard_hit_above_a_soft_one(self):
        got = audio.find_onsets(
            clicks([2.0, 5.0], amplitude=[0.9, 0.2]), SR, k=4.0)
        by_ms = {round(c["contact_ms"] / 1000): c["onset_peak"] for c in got}
        self.assertIn(2, by_ms)
        self.assertIn(5, by_ms)
        self.assertGreater(by_ms[2], by_ms[5])

    def test_results_are_sorted(self):
        got = found_ms(audio.find_onsets(clicks([7.0, 1.0, 4.0]), SR))
        self.assertEqual(got, sorted(got))

    def test_click_at_the_very_start(self):
        got = found_ms(audio.find_onsets(clicks([0.02], duration_s=3.0), SR))
        self.assertEqual(len(got), 1)
        self.assertLess(got[0], 100)

    def test_click_near_the_very_end(self):
        got = found_ms(audio.find_onsets(clicks([9.9], duration_s=10.0), SR))
        self.assertEqual(len(got), 1)
        self.assertGreater(got[0], 9800)

    def test_many_shots_are_all_found(self):
        times = [1.0 + 0.5 * i for i in range(16)]
        got = audio.find_onsets(clicks(times, duration_s=12.0), SR)
        self.assertEqual(len(got), len(times), found_ms(got))


class TestEnvelope(unittest.TestCase):
    def test_hop_is_five_milliseconds(self):
        _, hop_s = audio.envelope(np.zeros(SR, np.float32), SR)
        self.assertAlmostEqual(hop_s, 0.005, places=4)

    def test_length_tracks_duration(self):
        env, hop_s = audio.envelope(clicks([1.0], duration_s=4.0), SR)
        self.assertAlmostEqual(env.size * hop_s, 4.0, delta=0.1)

    def test_peaks_at_the_click(self):
        env, hop_s = audio.envelope(clicks([2.0], duration_s=4.0), SR)
        self.assertAlmostEqual(int(np.argmax(env)) * hop_s, 2.0, delta=0.03)


class TestCollapse(unittest.TestCase):
    def test_merges_within_gap_keeping_loudest(self):
        got = audio.collapse([{"contact_ms": 1000, "onset_peak": 5.0},
                              {"contact_ms": 2000, "onset_peak": 9.0}], 3.5)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["contact_ms"], 2000)

    def test_keeps_separated_candidates(self):
        got = audio.collapse([{"contact_ms": 1000, "onset_peak": 5.0},
                              {"contact_ms": 9000, "onset_peak": 4.0}], 3.5)
        self.assertEqual(len(got), 2)

    def test_chain_of_three(self):
        got = audio.collapse([{"contact_ms": 0, "onset_peak": 1.0},
                              {"contact_ms": 1000, "onset_peak": 2.0},
                              {"contact_ms": 2000, "onset_peak": 3.0}], 3.5)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["onset_peak"], 3.0)

    def test_empty(self):
        self.assertEqual(audio.collapse([], 3.5), [])

    def test_does_not_mutate_input(self):
        rows = [{"contact_ms": 1000, "onset_peak": 5.0},
                {"contact_ms": 2000, "onset_peak": 9.0}]
        audio.collapse(rows, 3.5)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["onset_peak"], 5.0)


class TestWavIO(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_round_trip(self):
        x = clicks([1.0], duration_s=2.0)
        path = write_wav(Path(self.tmp) / "a.wav", x)
        back, rate = audio.read_wav_mono(path)
        self.assertEqual(rate, SR)
        self.assertEqual(back.size, x.size)
        np.testing.assert_allclose(back, x, atol=1e-3)

    def test_detects_onsets_from_a_real_wav_file(self):
        path = write_wav(Path(self.tmp) / "a.wav", clicks([1.5, 4.0]))
        samples, rate = audio.read_wav_mono(path)
        self.assertEqual(len(audio.find_onsets(samples, rate)), 2)


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class TestDetectFromVideo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def make_video_with_clicks(self, times_s, duration_s=8.0):
        wav = write_wav(Path(self.tmp) / "a.wav",
                        clicks(times_s, duration_s=duration_s))
        out = Path(self.tmp) / "a.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
             "testsrc=size=160x120:rate=30:duration=%d" % int(duration_s),
             "-i", str(wav), "-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-shortest", "-y", str(out)],
            check=True, capture_output=True)
        return out

    def test_end_to_end_from_a_real_video(self):
        video = self.make_video_with_clicks([2.0, 5.0])
        got = audio.detect(video)
        self.assertEqual(len(got), 2, found_ms(got))
        self.assertLess(abs(got[0]["contact_ms"] - 2000), 60)
        self.assertLess(abs(got[1]["contact_ms"] - 5000), 60)

    def test_min_gap_collapses(self):
        video = self.make_video_with_clicks([2.0, 2.6, 6.0])
        self.assertEqual(len(audio.detect(video, min_gap_s=3.5)), 2)

    def test_video_without_audio_raises(self):
        out = Path(self.tmp) / "silent.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
             "testsrc=size=160x120:rate=30:duration=2", "-an",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(out)],
            check=True, capture_output=True)
        with self.assertRaises(audio.AudioError):
            audio.detect(out)


if __name__ == "__main__":
    unittest.main()
