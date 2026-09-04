"""Command line: python -m tennisproc <command> [options]

    run       the whole ETL
    probe     print the source video's facts
    detect    find swings and print them; renders nothing
    validate  check an output tree against the schema
    show      print one swing, with user-edit.json overlaid

`detect` prints candidate times and the rejection histogram without writing
anything, which is how one video's stage counts get looked at. It is no longer
the cheap tuning loop it was: the vision detector pose-scans the whole video,
and `detect` passes no work directory, so nothing it computes is cached.
Sweeping belongs in `scripts/process.sh`, which caches under out/<stem>/work/.

`--dry-run` with `--pose-backend=stub` stops after detection and prints the
candidate times, skipping the dense pose pass and verification -- which is all
a stub could report on anyway. Note that the scan itself still runs, on
synthetic poses, so those times are not a measurement of anything.

`detector` has no flag, so the CLI always runs the vision detector; the
audio-only one is reachable from `config.Settings(detector="audio")`.
"""

import argparse
import os
import sys

from . import config, errors, pipeline, probe, render, schema, session


def _add_settings_args(parser):
    s = config.Settings()
    g = parser.add_argument_group("detection")
    g.add_argument("--onset-k", type=float, default=s.onset_k,
                   help="audio threshold in MADs above the median; sets which "
                        "onsets exist for a swing to be dated by "
                        "(default %(default)s)")
    g.add_argument("--gap", type=float, default=s.min_gap_s, dest="min_gap_s",
                   help="collapse swings closer than this many seconds, when "
                        "they also happened in the same place "
                        "(default %(default)s)")
    g.add_argument("--same-place", type=float, default=s.same_place_torsos,
                   dest="same_place_torsos",
                   help="how far apart in torso heights two contacts may be "
                        "and still count as one player, for --gap "
                        "(default %(default)s)")
    g.add_argument("--min-torso", type=float, default=s.min_torso,
                   help="reject bodies smaller than this fraction of frame height")
    g.add_argument("--min-wrist-speed", type=float, default=s.min_wrist_speed,
                   help="reject swings slower than this (torso heights/second)")
    g.add_argument("--reanchor-min-speed", type=float,
                   default=s.reanchor_min_speed,
                   # Nothing moves any more; this only screens. See
                   # verify.measure_slot and Settings.reanchor_min_speed.
                   help="the speed required of a swing whose wrist peak is "
                        "far from the strike (default %(default)s)")

    g = parser.add_argument_group("pose")
    g.add_argument("--pose-backend", default=s.pose_backend,
                   choices=("mediapipe", "rtmpose", "stub"),
                   help="rtmpose is the accurate one and needs no display; "
                        "stub runs headless with synthetic poses")
    g.add_argument("--pose-model", default=s.pose_model)
    g.add_argument("--objects-backend", default=s.objects_backend,
                   choices=("none", "yolo", "stub"),
                   help="detect racket and ball with COCO-pretrained YOLO "
                        "(needs `pip install ultralytics`, AGPL-3.0)")
    g.add_argument("--objects-weights", default=s.objects_weights,
                   help="COCO weights for --objects-backend=yolo")
    g.add_argument("--pose-tiles", type=int, default=s.pose_tiles,
                   help="vertical tiles for a player too small to detect "
                        "whole; 0 or 1 means no tiling (default %(default)s)")
    g.add_argument("--pose-window", type=float, default=s.pose_window_s,
                   dest="pose_window_s",
                   help="seconds either side of the onset to decode")

    g = parser.add_argument_group("clip")
    g.add_argument("--pre", type=float, default=s.pre_s, dest="pre_s")
    g.add_argument("--post", type=float, default=s.post_s, dest="post_s")
    g.add_argument("--clip-height", type=int, default=s.clip_height)

    g = parser.add_argument_group("frames")
    g.add_argument("--span", type=float, default=s.frame_span_s,
                   dest="frame_span_s",
                   help="total seconds of stills around contact")
    g.add_argument("--fps", type=float, default=s.frame_fps, dest="frame_fps",
                   help="stills per second; 0 uses the source rate")
    g.add_argument("--long-edge", type=int, default=s.frame_long_edge,
                   dest="frame_long_edge")
    g.add_argument("--quality", type=int, default=s.frame_quality,
                   dest="frame_quality", help="JPEG quality 1-100")
    g.add_argument("--pad", type=float, default=s.crop_pad, dest="crop_pad")
    g.add_argument("--crop", default=s.crop_mode, dest="crop_mode",
                   choices=("full", "pose"),
                   help="full renders the whole frame; pose crops to the "
                        "tracked player (default %(default)s)")

    g = parser.add_argument_group("players")
    g.add_argument("--player-mode", default=s.player_mode,
                   choices=("side", "depth"))
    g.add_argument("--players", type=int, default=s.player_count,
                   dest="player_count", choices=(0, 1, 2),
                   help="0 to detect automatically (default %(default)s)")


def _settings_from(args):
    fields = {f for f in config.Settings().to_dict()}
    data = {k: v for k, v in vars(args).items() if k in fields}
    settings = config.Settings(**data)
    errors = settings.validate()
    if errors:
        raise SystemExit("bad settings:\n  " + "\n  ".join(errors))
    return settings


def cmd_probe(args):
    source = probe.probe(os.path.expanduser(args.video), raw_path=args.video)
    width = max(len(k) for k in source)
    for key, value in source.items():
        print("%-*s  %s" % (width, key, value))
    if not source["has_audio"]:
        print("\nwarning: no audio track, so this video cannot be processed")
    return 0


def cmd_detect(args):
    video = os.path.expanduser(args.video)
    settings = _settings_from(args)
    report = pipeline.Reporter(verbose=True)

    source = pipeline.stage_probe(video, raw_path=args.video)
    candidates = pipeline.stage_detect(video, settings, report, source=source)

    if args.dry_run and args.pose_backend == "stub":
        # A stub backend cannot verify anything, so stop at detection rather
        # than pretend. With the vision detector the scan behind these
        # candidates ran on synthetic poses too -- times only, no meaning.
        print("\ncandidates (audio only, no verification):")
        for i, candidate in enumerate(candidates, 1):
            print("  %3d  %8.2fs  peak %.1f"
                  % (i, candidate["contact_ms"] / 1000.0,
                     candidate["onset_peak"]))
        return 0

    track_list = pipeline.stage_pose(video, candidates, source, settings,
                                     work_dir=None, report=report)
    accepted, histogram = pipeline.stage_verify(track_list, settings, report)
    before = len(accepted)
    accepted = pipeline.dedupe_swings(accepted, settings.min_gap_s,
                                      settings.same_place_torsos)
    if before != len(accepted):
        print("dedupe: %d -> %d" % (before, len(accepted)))

    print("\nverified swings:")
    for i, (track, measured) in enumerate(accepted, 1):
        print("  %3d  %8.2fs  speed %5.2f  torso %.3f  %s"
              % (i, track.contact_ms / 1000.0, measured.wrist_peak_speed,
                 measured.torso_height, measured.hitting_side))
    print("\n%d candidates -> %d swings (%.0f%% kept)"
          % (len(candidates), len(accepted),
             100.0 * len(accepted) / max(1, len(candidates))))
    # Unconditional: `detect` never writes in either mode, so printing this
    # only when --dry-run was absent had it exactly backwards.
    print("(nothing written; use `run` to render)")
    return 0


def cmd_run(args):
    video = os.path.expanduser(args.video)
    settings = _settings_from(args)
    pipeline.run(video, args.outdir, settings,
                 report=pipeline.Reporter(verbose=not args.quiet),
                 raw_path=args.video, limit=args.limit)
    return 0


def cmd_proxy(args):
    """Build the review app's playable source for an EXISTING output tree.

    Deliberately not part of `run`: this rebuilds nothing but the video. A
    session's swing numbering is its identity -- `user-edit.json` is keyed by
    `swings/swing_NNN` -- so re-running detection to obtain a proxy would
    renumber every swing and orphan every human verdict in the tree. This
    reads the source path the tree already recorded, transcodes, and writes
    the `proxy` block into the session document. Nothing else is touched.
    """
    root = args.root.rstrip("/")
    if not os.path.isdir(root):
        raise SystemExit("not a directory: %s" % root)

    meta_path = os.path.join(root, "metadata.json")
    if not os.path.exists(meta_path):
        raise SystemExit("no metadata.json in %s" % root)
    doc = session.read_json(meta_path)

    video = args.video or doc.get("source", {}).get("path")
    if not video or not os.path.exists(video):
        raise SystemExit(
            "source video not found: %s\n"
            "  The tree records it as %r. Pass --video if it lives elsewhere."
            % (video, doc.get("source", {}).get("path")))

    dest = os.path.join(root, session.PROXY_FILE)
    if os.path.exists(dest) and not args.force:
        print("%s: proxy exists, skipping (use --force to rebuild)" % root)
        return

    info = render.build_proxy(video, dest, crf=args.crf, height=args.height,
                              fps=args.fps)
    doc["proxy"] = info
    errors = schema.validate_session(doc)
    if errors:
        raise SystemExit("proxy block did not validate: %s" % errors[:3])
    session.write_json(meta_path, doc)
    print("%s: %dx%d %.1ffps %.0fMB"
          % (root, info["width"], info["height"], info["fps"],
             info["bytes"] / 1e6))


def cmd_validate(args):
    root = args.root
    if not os.path.isdir(root):
        raise SystemExit("not a directory: %s" % root)
    checked, problems = session.validate_tree(root)
    for path, errors in problems:
        print("%s" % path)
        for error in errors[:10]:
            print("    %s" % error)
        if len(errors) > 10:
            print("    ... and %d more" % (len(errors) - 10))
    if problems:
        print("\n%d of %d documents have problems" % (len(problems), checked))
        return 1
    print("%d documents valid" % checked)
    return 0


def cmd_show(args):
    import json
    merged, warnings = session.load_swing(args.swing)
    if merged is None:
        raise SystemExit("no metadata.json in %s" % args.swing)
    for warning in warnings:
        print("warning: %s" % warning, file=sys.stderr)
    if args.frames:
        print("%-6s %-10s %-8s %s" % ("index", "source_ms", "offset", "stage"))
        for i, frame in enumerate(merged["frames"]):
            print("%-6d %-10d %+8d %s"
                  % (i, frame["source_ms"], frame["offset_contact_ms"],
                     frame["stage"] or "-"))
        return 0
    print(json.dumps(merged, indent=1))
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="tennisproc",
        description="Cut a tennis session video into per-shot clips, "
                    "cropped per player, with frames and metadata.")
    subs = parser.add_subparsers(dest="command", required=True)

    p = subs.add_parser("run", help="the whole ETL")
    p.add_argument("video")
    p.add_argument("--outdir", default="out")
    p.add_argument("--limit", type=int, default=0,
                   help="render only the first N swings")
    p.add_argument("--quiet", action="store_true")
    _add_settings_args(p)
    p.set_defaults(func=cmd_run)

    p = subs.add_parser("probe", help="print the source video's facts")
    p.add_argument("video")
    p.set_defaults(func=cmd_probe)

    p = subs.add_parser("detect", help="find shots without rendering")
    p.add_argument("video")
    p.add_argument("--dry-run", action="store_true",
                   help="audio stage only when used with --pose-backend=stub")
    _add_settings_args(p)
    p.set_defaults(func=cmd_detect)

    p = subs.add_parser("proxy",
                        help="build the playable source for an existing tree")
    p.add_argument("root", help="out/<video-stem>")
    p.add_argument("--video", help="source video, if not where the tree says")
    p.add_argument("--force", action="store_true", help="rebuild an existing proxy")
    p.add_argument("--crf", type=int, default=20)
    p.add_argument("--height", type=int, default=0, help="0 keeps the source size")
    p.add_argument("--fps", type=float, default=0.0, help="0 keeps the source rate")
    p.set_defaults(func=cmd_proxy)

    p = subs.add_parser("validate", help="check an output tree")
    p.add_argument("root", help="out/<video-stem>")
    p.set_defaults(func=cmd_validate)

    p = subs.add_parser("show", help="print one swing, edits overlaid")
    p.add_argument("swing", help="out/<stem>/swings/swing_001")
    p.add_argument("--frames", action="store_true",
                   help="table of frames instead of full JSON")
    p.set_defaults(func=cmd_show)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (errors.TennisprocError, OSError) as exc:
        # The base class, not a list of stage errors. Enumerating them meant
        # PoseError was not caught, so the one message that actually helps a
        # user on a headless box -- "MediaPipe needs a window-server
        # session" -- arrived as a traceback.
        print("error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
