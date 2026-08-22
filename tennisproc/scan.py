"""Find swings by watching the body, using sound only to place contact.

Audio proposes badly and dates well. Indoors a room rings, so one swing
arrives as several onsets -- 3.8 candidates per real swing at the shipped
threshold -- and a strike on the next court is just as loud as one in frame.
A body swings once, and a body that did not move did not hit anything.

So pose across the whole video finds the swings, and each peak takes the
timestamp of its nearest onset, which locates contact to about +-20ms. A peak
with no sound near it hit nothing and is dropped.

Measured against known_shots.json clustered to one entry per swing:
1.06-2.33 candidates per swing at 95-100% recall, against 3.8-3.9 for the
audio-first detector. It is also faster: one linear read beats seeking to a
window per candidate.
"""

import bisect

from .pose import BODY_JUMP

# Detection only -- contact comes from audio -- so this must resolve a
# swing, not an instant. 10fps is two to four samples through a stroke.
SCAN_FPS = 10.0

# Peak threshold in MADs above the median wrist speed. Swept on three
# sessions; 3.0 holds on all of them.
SCAN_K = 3.0

# Two peaks closer than this are one swing -- a stroke shows a takeback
# hump and a forward hump. At 2.0 real exchanges merge (99% -> 96%).
SCAN_MIN_GAP_S = 1.0

# How far from a vision peak an onset may sit and still be its strike.
AUDIO_WINDOW_S = 0.8


def _median(values):
    ordered = sorted(values)
    n = len(ordered)
    if not n:
        return 0.0
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def wrist_speed_series(samples):
    """[(source_ms, speed)] over a scan, in torso heights per second.

    The faster wrist wins at each sample: which hand is hitting is not known
    yet, and asking here would mean choosing a side from a single frame.

    Centred differences only; the ends are dropped rather than measured
    one-sided, which spans half the baseline and reads ~2x hot on jitter.
    """
    out = []
    for i in range(1, len(samples) - 1):
        before, after = samples[i - 1], samples[i + 1]
        torso = samples[i].get("torso") or 0.0
        dt = (after["ms"] - before["ms"]) / 1000.0
        if dt <= 0 or torso <= 0:
            continue
        # Refuse to measure across an identity change. `scan_video` follows one
        # body, but when it loses that body it falls back to the largest, and
        # measuring a "wrist" that teleported to another player invents the
        # fastest swing in the session.
        centres = [s.get("cx") for s in (before, samples[i], after)]
        if all(c is not None for c in centres) and (
                max(centres) - min(centres) > BODY_JUMP):
            continue
        best = 0.0
        for key in ("lw", "rw"):
            ax, ay = before[key]
            bx, by = after[key]
            dist = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 / torso
            best = max(best, dist / dt)
        out.append((samples[i]["ms"], best))
    return out


def find_peaks(series, k=SCAN_K, min_gap_s=SCAN_MIN_GAP_S):
    """Swing candidates: local maxima of wrist speed, one per swing.

    Strongest-first, then thinned, so the faster sample of a stroke survives.
    """
    if not series:
        return []
    speeds = [v for _, v in series]
    median = _median(speeds)
    mad = _median([abs(v - median) for v in speeds]) or 1e-9
    threshold = median + k * mad

    gap_ms = min_gap_s * 1000.0
    kept = []
    for ms, speed in sorted((r for r in series if r[1] > threshold),
                            key=lambda r: -r[1]):
        if all(abs(ms - other) >= gap_ms for other, _ in kept):
            kept.append((ms, speed))
    return sorted(kept)


def corroborate(peaks, onsets, window_s=AUDIO_WINDOW_S,
                min_gap_s=SCAN_MIN_GAP_S):
    """Give each swing the timestamp of its strike; drop the silent ones.

    A peak with no onset inside the window did not hit a ball -- on IMG_0304,
    the two peaks at 3.1s and 68.4s, which no speed threshold separates.
    """
    if not onsets:
        return []
    times = sorted(onsets, key=lambda o: o["contact_ms"])
    starts = [o["contact_ms"] for o in times]
    window_ms = window_s * 1000.0
    min_gap_ms = min_gap_s * 1000.0

    out = []
    for ms, speed in peaks:
        i = bisect.bisect_left(starts, ms)
        best = None
        for j in (i - 1, i, i + 1):
            if 0 <= j < len(times):
                delta = abs(starts[j] - ms)
                if delta <= window_ms and (best is None or delta < best[0]):
                    best = (delta, times[j])
        if best is None:
            continue
        onset = best[1]
        out.append({"contact_ms": onset["contact_ms"],
                    "onset_peak": onset.get("onset_peak"),
                    "scan_speed": round(float(speed), 3),
                    "scan_ms": int(ms)})

    # Thin again on the snapped times: snapping moves peaks by up to
    # `window_s`, so two can land on adjacent onsets of the same strike.
    out.sort(key=lambda c: -c["scan_speed"])
    kept = []
    for candidate in out:
        if all(abs(candidate["contact_ms"] - other["contact_ms"]) >= min_gap_ms
               for other in kept):
            kept.append(candidate)
    return sorted(kept, key=lambda c: c["contact_ms"])


def write_cache(path, samples, cache_hash):
    """Persist a scan so re-rendering never re-runs pose over the whole video."""
    import gzip
    import json
    with gzip.open(str(path), "wt", encoding="utf-8") as fh:
        fh.write(json.dumps({"cache_hash": cache_hash}) + "\n")
        for sample in samples:
            fh.write(json.dumps(sample) + "\n")


def read_cache(path, cache_hash):
    """Cached scan samples, or None if absent or built with other settings."""
    import gzip
    import json
    try:
        with gzip.open(str(path), "rt", encoding="utf-8") as fh:
            header = json.loads(fh.readline())
            if header.get("cache_hash") != cache_hash:
                return None
            return [json.loads(line) for line in fh if line.strip()]
    except (OSError, ValueError, EOFError):
        # EOFError is not an OSError: a run killed mid-write leaves a torn
        # gzip that crashed every later run. A torn cache reads as absent.
        return None
