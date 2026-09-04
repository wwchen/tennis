#!/usr/bin/env python3
"""Does `contact_ms` agree with the moment the ball actually turned round?

A strike reverses the ball. That is an EVENT, not a proxy, and it is the only
independent check on contact timing this project has: everything else available
is derived from the same pose the timing was chosen against, so it cannot
falsify it. An earlier attempt to score contact this way built its ground truth
out of MediaPipe's own landmarks and had to be withdrawn once that circularity
was noticed.

Reads the hand labels written by the app's ball-labelling mode
(`<session>/ball-labels.json`, keyed by source timestamp) and the candidate
windows they were made against.

Measured on IMG_0684 with 179 labels over 7 windows, 4 of which span a turn:

    window     turn    reversal    contact_ms    delta
    100050      136      100575        100571       +4
    114183      159      114392        114410      -18
    168867      161      169375        169385      -10
    448450      111      448808        448850      -42

    |delta| median 14 ms, mean 18, max 42, signed mean -16
    2 of 4 within one frame (17 ms); 4 of 4 within three.

So the audio onset dates contact to within a frame or two, which is what
`verify.py` claims when it argues for keeping contact at the onset rather than
moving it to the wrist-speed peak.

THE TURN IS NOT SMOOTHED, and that is deliberate. Fitting a velocity to several
points either side of each candidate split was tried twice -- over the whole run
and over a local four-point span -- and both were worse, at median errors of 124
and 79 ms against 14 for a plain frame-to-frame difference, with every estimate
biased early. A reversal happens within one frame; averaging over four moves the
answer off it.

Usage:
    scripts/ball_reversal.py out/IMG_0684
"""

import argparse
import gzip
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Labels more than this far apart belong to different swings. The windows they
# are made in are contact +/- 500 ms and sit tens of seconds apart, so anything
# near a second is a gap between windows rather than a gap in one flight.
RUN_GAP_MS = 1000

# Direction change, in degrees, below which the labels did not capture a strike.
# On IMG_0684 the four windows that do capture one turn 111-161 degrees; the
# three that do not manage 21, 35 and 79, and in each the labels sit entirely on
# one side of contact. Those are reported rather than scored: with no reversal
# in the data there is nothing to compare, and counting them as 400 ms misses
# would blame the pipeline for a gap in the labelling.
MIN_TURN_DEG = 100.0

MIN_POINTS = 4


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("session_dir", help="e.g. out/IMG_0684")
    return p.parse_args(argv)


def load(session_dir):
    """(labelled positions sorted by ms, count of "no ball", contact times)."""
    with open(os.path.join(session_dir, "ball-labels.json")) as fh:
        doc = json.load(fh)
    labels = doc.get("labels") or {}
    candidates = os.path.join(session_dir, "work", "ball-candidates.jsonl.gz")
    with gzip.open(candidates, "rt") as fh:
        header = json.loads(fh.readline())
    positions = sorted((int(ms), xy) for ms, xy in labels.items() if xy is not None)
    blanks = sum(1 for xy in labels.values() if xy is None)
    return positions, blanks, header.get("contacts") or []


def runs_of(positions):
    """Split labels into one list per swing."""
    if not positions:
        return []
    out = [[positions[0]]]
    for point in positions[1:]:
        if point[0] - out[-1][-1][0] <= RUN_GAP_MS:
            out[-1].append(point)
        else:
            out.append([point])
    return out


def sharpest_turn(times, points):
    """(degrees, ms) of the hardest direction change, or None.

    The step-to-step difference, unsmoothed -- see the module docstring.
    """
    steps = np.diff(points, axis=0)
    best = None
    for i in range(len(steps) - 1):
        a, b = steps[i], steps[i + 1]
        na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
        if na < 1e-6 or nb < 1e-6:
            continue
        cos = max(-1.0, min(1.0, float(a @ b) / (na * nb)))
        degrees = math.degrees(math.acos(cos))
        if best is None or degrees > best[0]:
            # Between the two frames the turn happens across, not on either.
            best = (degrees, (times[i + 1] + times[i + 2]) / 2.0)
    return best


def main(argv=None):
    args = parse_args(argv)
    positions, blanks, contacts = load(args.session_dir)
    if not contacts:
        print("no contact times in the candidate header; nothing to compare")
        return 1

    groups = runs_of(positions)
    print("%d labelled positions and %d \"no ball\", across %d swings\n"
          % (len(positions), blanks, len(groups)))
    print("%-9s %5s %8s %11s %11s %8s"
          % ("window", "pts", "turn", "reversal", "contact", "delta"))

    deltas, skipped = [], 0
    for group in groups:
        times = np.array([p[0] for p in group], dtype=float)
        points = np.array([p[1] for p in group], dtype=float)
        if len(group) < MIN_POINTS:
            print("%-9d %5d   too few points" % (group[0][0], len(group)))
            skipped += 1
            continue
        turn = sharpest_turn(times, points)
        if turn is None or turn[0] < MIN_TURN_DEG:
            print("%-9d %5d %7.0f   labels do not span the turn"
                  % (group[0][0], len(group), turn[0] if turn else 0.0))
            skipped += 1
            continue
        degrees, reversal = turn
        contact = min(contacts, key=lambda c: abs(c - reversal))
        delta = reversal - contact
        deltas.append(delta)
        print("%-9d %5d %7.0f %11.0f %11d %+8.0f"
              % (group[0][0], len(group), degrees, reversal, contact, delta))

    if not deltas:
        print("\nno window's labels span a turn; nothing scored")
        return 0
    size = np.abs(np.array(deltas))
    print("\nscored %d, skipped %d for want of coverage" % (len(size), skipped))
    print("|delta| median %.0f ms  mean %.0f  max %.0f   (one frame = 17 ms)"
          % (np.median(size), size.mean(), size.max()))
    print("within one frame: %d/%d   within three: %d/%d"
          % ((size <= 17).sum(), len(size), (size <= 50).sum(), len(size)))
    # A signed mean far from zero would say the onset systematically leads or
    # lags the strike, which is a fixable offset rather than noise.
    print("signed mean %+.0f ms" % float(np.mean(deltas)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
