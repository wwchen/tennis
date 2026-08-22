"""Score an output tree against whatever ground truth exists.

Printed after every run of `scripts/process.sh`, so a settings change is
always followed by its cost. Two references, and they answer different
questions:

  known shots   `tests/fixtures/known_shots.json`, clustered to one entry per
                swing. That clustering is not optional -- the file lists audio
                ONSETS from an earlier pipeline, so one swing appears two or
                three times (12 entries for the 6 swings in IMG_0304), and
                scoring against it unclustered rewards a detector for finding
                echoes. That mistake cost this project a day.

  your verdicts every `user-edit.json` marked `false_positive`. Sparse, but the
                only reference that is definitely right, because a human
                watched the clip.

`swings per real swing` is the number to watch alongside recall: 1.0 means one
clip per swing, and the audio-first detector used to sit near 4.
"""

import glob
import json
import os
import sys

# How far apart two onsets of the SAME swing can be. A strike and its echoes
# off net, fence and wall arrive within a few hundred ms; a second shot does
# not follow that fast.
CLUSTER_S = 1.0

# How far a clip may sit from a swing's sound and still be that swing. Small,
# because a swing is now an interval (its onsets) rather than a point, and this
# only has to cover the slack between a detection and that interval.
TOLERANCE_S = 0.35


def clustered_truth(path):
    """{stem: [(first_onset, last_onset)]} -- one interval per real swing.

    `known_shots.json` lists audio ONSETS from an earlier pipeline, so a single
    swing appears two or three times in it. Grouping them is what turns the
    file into a count of swings; ungrouped it rewards a detector for finding
    echoes, which is how this project once measured "99-100% recall" for a
    detector emitting four clips per swing.

    Grouping is bounded by the group's FIRST onset, not its last. Single-link
    chaining -- comparing against the last -- lets a rally walk: six genuine
    shots 0.9s apart merge into one "swing", shrinking the denominator and
    inflating both recall and clips-per-swing. Measured on this fixture,
    chaining reported 191 swings where bounded grouping reports 198.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    out = {}
    for stem, entry in (data.get("sessions") or {}).items():
        times = sorted(entry.get("verified_times_s") or [])
        groups = []
        for t in times:
            if groups and t - groups[-1][0] <= CLUSTER_S:
                groups[-1].append(t)
            else:
                groups.append([t])
        if groups:
            out[stem] = [(g[0], g[-1]) for g in groups]
    return out


def match(events, detections, tolerance=TOLERANCE_S):
    """Pair each swing with at most one clip, and each clip with at most one swing.

    Returns (matched_pairs, unmatched_events, unmatched_detections).

    One-to-one, closest first. Many-to-one scoring let a single clip satisfy
    two neighbouring swings, which reported 100% recall and 0.50 clips per
    swing for a detector that had found one of two -- both numbers wrong, both
    in the detector's favour.
    """
    def distance(event, t):
        first, last = event
        if t < first:
            return first - t
        if t > last:
            return t - last
        return 0.0

    pairs = sorted(
        ((distance(e, t), ei, ti)
         for ei, e in enumerate(events)
         for ti, t in enumerate(detections)
         if distance(e, t) <= tolerance),
        key=lambda r: (r[0], r[1], r[2]))

    taken_events, taken_detections, matched = set(), set(), []
    for _, ei, ti in pairs:
        if ei in taken_events or ti in taken_detections:
            continue
        taken_events.add(ei)
        taken_detections.add(ti)
        matched.append((ei, ti))
    return (matched,
            [i for i in range(len(events)) if i not in taken_events],
            [i for i in range(len(detections)) if i not in taken_detections])


def contacts(root, stem):
    out = []
    for path in sorted(glob.glob(os.path.join(root, stem, "swings", "*",
                                              "metadata.json"))):
        try:
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            continue
        edit = os.path.join(os.path.dirname(path), "user-edit.json")
        verdict = None
        if os.path.exists(edit):
            try:
                with open(edit, encoding="utf-8") as fh:
                    verdict = (json.load(fh).get("labels") or {}).get("verdict")
            except (OSError, ValueError):
                pass
        out.append((doc["detection"]["contact_ms"] / 1000.0, verdict))
    return out


def main(argv):
    root = argv[1] if len(argv) > 1 else "out"
    wanted = argv[2:]
    here = os.path.dirname(os.path.abspath(__file__))
    truth = clustered_truth(os.path.join(here, os.pardir, "tests", "fixtures",
                                         "known_shots.json"))

    stems = wanted or sorted(
        os.path.basename(p) for p in glob.glob(os.path.join(root, "*"))
        if os.path.isdir(os.path.join(p, "swings")))
    if not stems:
        print("nothing to evaluate in %s" % root)
        return 0

    print("%-12s %7s %8s %8s %10s %9s" % ("session", "swings", "real",
                                          "recall", "per swing", "rejected"))
    total_swings = total_rejected = 0
    for stem in stems:
        rows = contacts(root, stem)
        if not rows:
            print("%-12s %7s" % (stem, "-"))
            continue
        times = [t for t, _ in rows]
        rejected = sum(1 for _, v in rows if v == "false_positive")
        total_swings += len(rows)
        total_rejected += rejected

        events = truth.get(stem)
        if events:
            matched, _, extra = match(events, times)
            hit = len(matched)
            print("%-12s %7d %8d %7.0f%% %9.2fx %9s"
                  % (stem, len(rows), len(events), 100.0 * hit / len(events),
                     len(rows) / float(len(events)),
                     "%d" % rejected if rejected else "-"))
        else:
            print("%-12s %7d %8s %8s %10s %9s"
                  % (stem, len(rows), "-", "-", "-",
                     "%d" % rejected if rejected else "-"))

    if total_rejected:
        print("\n%d of %d swings marked 'not a swing' by hand (%.0f%%)"
              % (total_rejected, total_swings,
                 100.0 * total_rejected / total_swings))
    print("\nreal = swings in known_shots.json, clustered at %.1fs "
          "(the file lists onsets, not swings)" % CLUSTER_S)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
