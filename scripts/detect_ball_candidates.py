#!/usr/bin/env python3
"""Native-rate ball candidates around a sample of contacts, for hand labelling.

The app's ball-labelling mode confirms or corrects a detector's guesses rather
than asking anyone to click from blank, so it needs candidates to offer. This
writes them.

WHY NOT `detect_objects.py`. That samples the WHOLE video at a uniform rate for
the playback overlay, and 10 fps is the right rate there because a racket
interpolates smoothly between samples. A ball does not: at 15 m/s it covers
most of a torso height between NATIVE frames, so a 10 fps sample of it does not
move slowly, it teleports. Labelling has to happen at the rate the ball was
filmed at.

Native rate over a whole session is ~58 minutes and 30,000 frames, almost none
of which anyone will look at. This covers contact +/- `--half-ms` for a sample
of swings instead: ~60 frames each, ~2.5 minutes for twenty swings.

The output shares `objects.jsonl.gz`'s line format so the app's existing reader
works, with `fps: 0` in the header marking it native-rate and windowed rather
than a uniform sample.

Usage:
    scripts/detect_ball_candidates.py out/IMG_0684 --swings 20
"""

import argparse
import gzip
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import objects as objects_mod


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("session_dir", help="e.g. out/IMG_0684")
    p.add_argument("--swings", type=int, default=20,
                   help="how many swings to sample, spread evenly (default 20)")
    p.add_argument("--half-ms", type=float, default=500.0,
                   help="half-width of each window around contact (default 500)")
    p.add_argument("--weights", default="yolo11x.pt")
    p.add_argument("--imgsz", type=int, default=objects_mod.IMGSZ)
    p.add_argument("--conf", type=float, default=objects_mod.CONF)
    return p.parse_args(argv)


def sample_contacts(swings, count):
    """`count` contact times, spread evenly across the session.

    Evenly rather than the first N: the court fills with dead balls as a session
    runs, so the first twenty swings are the easiest twenty and would make the
    candidates look better than they are.
    """
    if not swings or count < 1:
        return []
    if count >= len(swings):
        chosen = swings
    elif count == 1:
        chosen = [swings[len(swings) // 2]]
    else:
        chosen = [swings[round(k * (len(swings) - 1) / (count - 1))]
                  for k in range(count)]
    return sorted({int(s["contact_ms"]) for s in chosen})


def main(argv=None):
    args = parse_args(argv)
    import cv2

    root = args.session_dir
    with open(os.path.join(root, "metadata.json")) as fh:
        meta = json.load(fh)
    contacts = sample_contacts(meta.get("swings") or [], args.swings)
    if not contacts:
        print("no swings in %s/metadata.json" % root)
        return 1

    backend = objects_mod.YoloBackend(weights=args.weights, imgsz=args.imgsz,
                                      conf=args.conf)
    cap = cv2.VideoCapture(os.path.join(root, "source.mp4"))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print("%d swings sampled, %.0f s of footage to scan"
          % (len(contacts), len(contacts) * 2 * args.half_ms / 1000.0))

    # Bounds are collected during the pass, not declared up front. A msec seek
    # lands ON OR BEFORE the requested time, so a window's first decoded frame
    # precedes the time asked for. Declaring the REQUESTED bounds put 29 of 1230
    # frames outside every window, where the app correctly reported "no window"
    # and refused to count them towards any window's progress.
    windows, kept = [], []
    started = time.time()
    for contact in contacts:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(contact - args.half_ms))
        low = high = None
        while True:
            position = cap.get(cv2.CAP_PROP_POS_MSEC)
            ok, frame = cap.read()
            if not ok or position > contact + args.half_ms:
                break
            found = backend.detect(frame)
            row = {"ms": int(round(position))}
            if found["ball"]:
                row["ball"] = [[round(b.x1, 1), round(b.y1, 1),
                                round(b.x2 - b.x1, 1), round(b.y2 - b.y1, 1),
                                round(b.conf, 3)] for b in found["ball"]]
            kept.append(row)
            low = row["ms"] if low is None else min(low, row["ms"])
            high = row["ms"] if high is None else max(high, row["ms"])
        windows.append([low, high] if low is not None else None)
    cap.release()
    backend.close()

    # `windows` and `contacts` are written INDEX-ALIGNED, which is what lets a
    # reader attribute a window to the swing it was cut around. Without that,
    # scoring anything against "the nearest contact" flatters itself: a badly
    # wrong measurement gets matched to whichever contact happens to sit closest
    # and its error is bounded by the gap between swings rather than reported.
    pairs = [(w, c) for w, c in zip(windows, contacts) if w is not None]
    out = os.path.join(root, "work", "ball-candidates.jsonl.gz")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with gzip.open(out, "wt", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "space": "source_display",
            "detector": "yolo/coco",
            "weights": args.weights,
            "imgsz": args.imgsz,
            "conf": args.conf,
            # 0 means native rate; the file is windowed, not a uniform sample.
            "fps": 0,
            "width": width,
            "height": height,
            "windows": [w for w, _ in pairs],
            "contacts": [c for _, c in pairs],
        }) + "\n")
        for row in kept:
            fh.write(json.dumps(row) + "\n")

    print("wrote %s: %d frames in %d windows, %.0f s, %.0f KB"
          % (out, len(kept), len(pairs), time.time() - started,
             os.path.getsize(out) / 1024.0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
