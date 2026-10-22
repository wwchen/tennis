#!/usr/bin/env python3
"""Overlay pose.json landmarks onto frame stills, for sanity-checking the
detector by eye while tuning.

    .venv/bin/python scripts/draw_pose.py out/IMG_0474/swings/swing_011
    .venv/bin/python scripts/draw_pose.py out/IMG_0474            # every swing

Writes annotated copies to <swing_dir>/frames_pose/, leaving the originals
untouched. Points come from pose.json in frame-normalized (0..1, top-left)
space; each frame still is itself a crop-then-scale of the source frame, so
the same normalized coordinates apply directly to the still's own pixel
dimensions whenever crop is "full" (x=0, y=0, w/h = source size). A non-full
crop needs remapping through metadata.json's `crop` rect first -- not done
here since every session so far uses crop_mode=full.
"""
import argparse
import json
import os
import sys

import cv2

# BlazePose's 33 landmarks, standard skeleton edges.
CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8),
    (9, 10),
    (11, 12), (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (27, 29), (29, 31), (27, 31),
    (24, 26), (26, 28), (28, 30), (30, 32), (28, 32),
]

MIN_SCORE = 0.3
MAX_GAP_MS = 100


def draw_pose(img, points):
    h, w = img.shape[:2]
    xy = [(int(x * w), int(y * h)) for x, y, _score in points]
    scores = [p[2] for p in points]

    for a, b in CONNECTIONS:
        if scores[a] < MIN_SCORE or scores[b] < MIN_SCORE:
            continue
        cv2.line(img, xy[a], xy[b], (0, 255, 0), 2, cv2.LINE_AA)
    for (x, y), score in zip(xy, scores):
        if score < MIN_SCORE:
            continue
        cv2.circle(img, (x, y), 3, (0, 0, 255), -1, cv2.LINE_AA)
    return img


def render_swing(swing_dir):
    """Write <swing_dir>/frames_pose/. Returns the number of frames written.

    Raises SystemExit's message as a plain string (not exiting) so a whole
    -session run can report one swing's problem and keep going.
    """
    pose_path = os.path.join(swing_dir, "pose.json")
    if not os.path.exists(pose_path):
        raise ValueError("no pose.json")
    with open(pose_path) as f:
        pose_doc = json.load(f)
    if pose_doc["space"] != "frame_normalized":
        raise ValueError("unexpected pose space: %s" % pose_doc["space"])

    with open(os.path.join(swing_dir, "metadata.json")) as f:
        meta = json.load(f)
    crop = meta["crop"]
    src = meta["source"]
    full_frame = (crop["x"] == 0 and crop["y"] == 0
                  and crop["w"] == src["width"] and crop["h"] == src["height"])
    if not full_frame:
        raise ValueError("crop is not full-frame (%r) -- landmarks need "
                          "remapping through the crop rect, not implemented "
                          "here" % crop)

    # pose.json is sampled at the pose scanner's own rate (tens of ms), not at
    # the frame stills' timestamps (frame_span_s/frame_fps, often 500ms
    # apart) -- so this is a nearest-neighbour match, not an exact one.
    scored = [(row["source_ms"], row["pose"]) for row in pose_doc["frames"]
              if row.get("pose")]
    if not scored:
        raise ValueError("pose.json has no scored frames")

    def nearest_pose(source_ms):
        ms, pose = min(scored, key=lambda row: abs(row[0] - source_ms))
        return pose if abs(ms - source_ms) <= MAX_GAP_MS else None

    out_dir = os.path.join(swing_dir, "frames_pose")
    os.makedirs(out_dir, exist_ok=True)

    written = 0
    for frame in meta["frames"]:
        pose = nearest_pose(frame["source_ms"])
        frame_path = os.path.join(swing_dir, frame["file"])
        img = cv2.imread(frame_path)
        if img is None:
            print("  skip (unreadable): %s" % frame["file"])
            continue
        if pose:
            draw_pose(img, pose["points"])
        dest = os.path.join(out_dir, os.path.basename(frame["file"]))
        cv2.imwrite(dest, img)
        written += 1
    return written


def is_swing_dir(path):
    # A session dir also has its own metadata.json (session schema, no
    # per-swing "swings" list) -- so this is not just an existence check.
    meta_path = os.path.join(path, "metadata.json")
    if not os.path.exists(meta_path):
        return False
    with open(meta_path) as f:
        meta = json.load(f)
    return meta.get("schema") == "tennis.swing/1"


def swing_dirs_under(session_dir):
    swings_root = os.path.join(session_dir, "swings")
    if not os.path.isdir(swings_root):
        return []
    return sorted(os.path.join(swings_root, name)
                  for name in os.listdir(swings_root)
                  if is_swing_dir(os.path.join(swings_root, name)))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="out/<stem>/swings/swing_NNN, or out/<stem> "
                                 "for every swing in the session")
    args = ap.parse_args()

    if is_swing_dir(args.path):
        targets = [args.path]
    else:
        targets = swing_dirs_under(args.path)
        if not targets:
            sys.exit("no swings found under %s" % args.path)

    ok = 0
    for swing_dir in targets:
        try:
            written = render_swing(swing_dir)
        except ValueError as exc:
            print("%s: %s" % (swing_dir, exc))
            continue
        print("%s: %d frames" % (swing_dir, written))
        ok += 1

    if len(targets) > 1:
        print("%d/%d swings rendered" % (ok, len(targets)))
    elif ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
