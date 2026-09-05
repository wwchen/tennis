#!/usr/bin/env python3
"""Per-frame racket/ball/person boxes for a whole video, for overlay playback.

Writes one line per sampled frame to a gzipped JSONL, in source-display
pixels -- the same space the `objects` block uses in swing metadata, and the
space `source.mp4` is already in, so a player can draw these straight over the
video with no transform beyond scaling by the displayed width.

SAMPLING RATE IS THE WHOLE DESIGN DECISION, and the two objects want
different ones:

  * A racket or a person moves slowly enough that 10 fps looks continuous
    once a player interpolates between samples.
  * A ball at 15 m/s covers most of a torso height BETWEEN frames. Sampled
    below native rate it does not move smoothly, it teleports -- and
    interpolating between two such samples draws a straight line through
    positions the ball never occupied, which is worse than drawing nothing.

So `--fps 0` means native rate and is the honest setting for ball overlay; 10
is fine when only the racket matters and costs a sixth as much.

Usage:
    scripts/detect_objects.py out/IMG_0684/source.mp4 \\
        --out out/IMG_0684/work/objects.jsonl.gz --fps 10
"""

import argparse
import gzip
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import objects as objects_mod
from tennisproc import probe, tracks


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video")
    p.add_argument("--out", required=True, help="destination .jsonl.gz")
    p.add_argument("--fps", type=float, default=10.0,
                   help="sampling rate; 0 means every frame (needed for ball)")
    p.add_argument("--start-ms", type=float, default=0.0)
    p.add_argument("--end-ms", type=float, default=0.0,
                   help="0 means to the end")
    p.add_argument("--weights", default="yolo11x.pt")
    p.add_argument("--imgsz", type=int, default=objects_mod.IMGSZ)
    p.add_argument("--conf", type=float, default=objects_mod.CONF)
    p.add_argument("--rotate", action="store_true",
                   help="apply the source rotation; omit for an already "
                        "display-oriented proxy such as source.mp4")
    return p.parse_args(argv)


def boxes_to_rows(found):
    """{"racket": [[x, y, w, h, conf], ...], ...}, rounded for file size.

    Arrays rather than objects: at native rate a 500 s session is 30k frames
    and the key names would outweigh the numbers they label.
    """
    out = {}
    for key, items in found.items():
        if not items:
            continue
        out[key] = [[round(b.x1, 1), round(b.y1, 1),
                     round(b.x2 - b.x1, 1), round(b.y2 - b.y1, 1),
                     round(b.conf, 3)] for b in items]
    return out


def main(argv=None):
    args = parse_args(argv)
    import cv2

    source = probe.probe(args.video)
    backend = objects_mod.YoloBackend(weights=args.weights, imgsz=args.imgsz,
                                      conf=args.conf)
    rotation = source.get("rotation", 0) if args.rotate else 0
    step_ms = (1000.0 / args.fps) if args.fps > 0 else 0.0
    end_ms = args.end_ms or source["duration_ms"]

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".",
                exist_ok=True)
    cap = tracks.open_capture(args.video, cv2)
    written = decoded = 0
    started = time.time()
    try:
        if args.start_ms:
            cap.set(cv2.CAP_PROP_POS_MSEC, float(args.start_ms))
        with gzip.open(args.out, "wt", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "space": "source_display",
                "detector": "yolo/coco",
                "weights": args.weights,
                "imgsz": args.imgsz,
                "conf": args.conf,
                "fps": args.fps,
                "width": source["width"],
                "height": source["height"],
            }) + "\n")
            next_ms = args.start_ms
            while True:
                # Read the presentation time back from the decoder rather than
                # counting frames: this footage is variable frame rate, so an
                # index-derived timestamp drifts away from the video the
                # overlay is drawn on.
                position_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
                ok, raw = cap.read()
                if not ok or position_ms > end_ms:
                    break
                decoded += 1
                if step_ms and position_ms < next_ms:
                    continue
                next_ms = position_ms + step_ms
                frame = tracks.rotate_frame(raw, rotation, cv2)
                row = boxes_to_rows(backend.detect(frame))
                if row:
                    row["ms"] = int(round(position_ms))
                    fh.write(json.dumps(row) + "\n")
                written += 1
                if written % 200 == 0:
                    rate = written / max(1e-6, time.time() - started)
                    print("  %d sampled (%.1f/s)" % (written, rate), flush=True)
    finally:
        cap.release()
        backend.close()

    elapsed = time.time() - started
    print("wrote %s: %d frames sampled from %d decoded, %.0fs, %.1f KB"
          % (args.out, written, decoded, elapsed,
             os.path.getsize(args.out) / 1024.0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
