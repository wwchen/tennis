"""Shot candidates from the audio track.

A racket striking a ball is a sharp broadband transient. Finding it in the
audio gives contact timing to roughly +/-20 ms, which is far better than
anything recoverable from 30 fps video, where a frame is 33 ms and the ball
moves feet between frames.

The detector is deliberately plain: high-pass by first difference, sliding
RMS envelope, then threshold at `median + k * MAD` over the whole session.
Median and MAD rather than mean and standard deviation because a session
contains loud outliers by definition -- the shots themselves -- and they
would inflate a mean-based threshold until quiet shots fall below it.

This stage over-reports on purpose. It cannot tell a ball strike from a
dropped racket or a clap, so pose verification downstream is what rejects
those; a candidate that never reaches the verifier can never be recovered.

Only stdlib + numpy: the wav is read with `wave`, not a decoder library.
"""

import os
import subprocess
import tempfile
import wave

import numpy as np

SAMPLE_RATE = 22050
ENV_WINDOW_S = 0.020   # RMS window
ENV_HOP_S = 0.005      # envelope resolution: 5 ms
REFRACTORY_S = 0.12    # ignore a second peak this close to the last one


class AudioError(RuntimeError):
    pass


def extract_wav(video, wav_path, sample_rate=SAMPLE_RATE):
    """Decode the first audio stream to mono 16-bit PCM."""
    cmd = ["ffmpeg", "-v", "error", "-i", str(video),
           "-map", "0:a:0", "-ac", "1", "-ar", str(sample_rate),
           "-c:a", "pcm_s16le", "-y", str(wav_path)]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0 or not os.path.exists(wav_path):
        raise AudioError("could not extract audio from %s: %s"
                         % (video, result.stderr.decode("utf-8", "replace")))
    return wav_path


def read_wav_mono(path):
    """Return (samples float32 in -1..1, sample_rate)."""
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width != 2:
        raise AudioError("expected 16-bit PCM, got %d-byte samples" % width)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def envelope(samples, sample_rate, window_s=ENV_WINDOW_S, hop_s=ENV_HOP_S):
    """Sliding RMS of the first-difference signal.

    The difference acts as a crude high-pass: a ball strike is mostly high
    frequency, while court rumble and voices are not, so differencing lifts
    the thing we want above the thing we don't.
    """
    if samples.size < 2:
        return np.zeros(0, dtype=np.float32), hop_s

    high = np.diff(samples)
    window = max(1, int(round(window_s * sample_rate)))
    hop = max(1, int(round(hop_s * sample_rate)))

    # Sliding sum of squares via a cumulative sum: O(n) regardless of window.
    power = np.concatenate(([0.0], np.cumsum(high.astype(np.float64) ** 2)))
    starts = np.arange(0, max(1, high.size - window + 1), hop)
    if starts.size == 0:
        starts = np.array([0])
    ends = np.minimum(starts + window, high.size)
    env = np.sqrt((power[ends] - power[starts]) / np.maximum(1, ends - starts))
    return env.astype(np.float32), hop / float(sample_rate)


def _threshold(env, k):
    median = float(np.median(env))
    mad = float(np.median(np.abs(env - median)))
    if mad <= 0:
        # Degenerate (silence, or a synthetic tone): fall back to spread so a
        # single click in a quiet file is still found.
        mad = float(env.std()) or 1e-9
    return median + k * mad, median, mad


def find_onsets(samples, sample_rate, k=8.0, refractory_s=REFRACTORY_S):
    """Return [{"contact_ms", "onset_peak"}] sorted by time.

    `onset_peak` is the envelope value at the peak, in units of MAD above the
    median, so it is comparable across videos with different gain.
    """
    env, hop_s = envelope(samples, sample_rate)
    if env.size == 0:
        return []

    threshold, median, mad = _threshold(env, k)
    hot = env > threshold
    if not hot.any():
        return []

    onsets = []
    refractory_hops = max(1, int(round(refractory_s / hop_s)))
    i = 0
    n = env.size
    while i < n:
        if not hot[i]:
            i += 1
            continue
        # Walk to the end of this contiguous hot run, then take its peak
        # rather than its leading edge: the transient's loudest point is the
        # strike, and a run can be several hops long.
        j = i
        while j < n and hot[j]:
            j += 1
        peak = i + int(np.argmax(env[i:j]))
        if not onsets or peak - onsets[-1][0] >= refractory_hops:
            onsets.append((peak, float(env[peak])))
        elif env[peak] > onsets[-1][1]:
            onsets[-1] = (peak, float(env[peak]))  # keep the louder of the two
        i = max(j, peak + 1)

    return [{"contact_ms": int(round(p * hop_s * 1000)),
             "onset_peak": round((v - median) / mad, 3)}
            for p, v in onsets]


def collapse(candidates, min_gap_s):
    """Merge candidates closer than min_gap_s, keeping the loudest.

    One swing makes more than one noise -- the strike, then the ball hitting
    a fence or the ground. Those are not separate shots.
    """
    if not candidates:
        return []
    gap_ms = min_gap_s * 1000.0
    kept = [dict(candidates[0])]
    for cand in candidates[1:]:
        if cand["contact_ms"] - kept[-1]["contact_ms"] < gap_ms:
            if cand["onset_peak"] > kept[-1]["onset_peak"]:
                kept[-1] = dict(cand)
        else:
            kept.append(dict(cand))
    return kept


def detect(video, k=8.0, min_gap_s=0.0, sample_rate=SAMPLE_RATE):
    """Full audio stage: video -> candidates.

    min_gap_s of 0 returns every onset; the caller usually collapses later,
    after pose verification has thrown out the ones that were not swings.
    """
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "audio.wav")
        extract_wav(video, wav, sample_rate)
        samples, rate = read_wav_mono(wav)
    candidates = find_onsets(samples, rate, k=k)
    return collapse(candidates, min_gap_s) if min_gap_s > 0 else candidates
