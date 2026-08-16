"""Stage orchestration: candidates -> tracks -> verified swings -> disk.

Each stage is callable on its own and caches its expensive output, so tuning
the detector never re-runs pose and re-rendering never re-runs either. The
stages, in order:

    probe    read the source video's facts
    detect   audio onsets -> candidates
    pose     one decode pass per candidate -> landmark tracks   (cached)
    verify   accept/reject each candidate, measure the swing
    render   cut clips, extract frames
    index    write the session document

`--no-classify` does not appear here because there is no classifier: stroke
and per-frame stage ship null by design. What this pipeline guarantees is
that every clip, crop, frame and timestamp is produced regardless.
"""

import os

from . import audio, crop, players, probe, render, schema, session, tracks
from . import pose as pose_mod
from . import verify as verify_mod


class Reporter:
    """Progress output. Quiet by default so tests stay silent."""

    def __init__(self, verbose=True):
        self.verbose = verbose

    def say(self, message):
        if self.verbose:
            print(message, flush=True)


def stage_probe(video, raw_path=None):
    source = probe.probe(video, raw_path=raw_path)
    if not source["has_audio"]:
        raise probe.ProbeError(
            "%s has no audio track. Detection is audio-primary: the ball "
            "strike is what locates a shot to within ~20ms. A silent video "
            "cannot be processed." % source["name"])
    return source


def stage_detect(video, settings, report=None):
    """Audio candidates, before any pose verification."""
    candidates = audio.detect(video, k=settings.onset_k)
    if report:
        report.say("detect: %d candidates at k=%.1f"
                   % (len(candidates), settings.onset_k))
    return candidates


def stage_pose(video, candidates, source, settings, work_dir=None,
               report=None):
    """One landmark track per candidate, cached by settings hash."""
    cache_path = (os.path.join(work_dir, "pose.jsonl.gz") if work_dir
                  else None)
    cache_key = "%s:%s" % (source["sha256_16"], settings.cache_hash())

    if cache_path:
        cached = tracks.read_cache(cache_path, cache_key)
        if cached is not None and len(cached) == len(candidates):
            if report:
                report.say("pose: %d tracks from cache" % len(cached))
            return cached

    backend = pose_mod.make_backend(
        settings.pose_backend, model_path=settings.pose_model,
        tiles=max(1, settings.pose_tiles),
        min_confidence=settings.pose_min_confidence,
        window_s=settings.pose_window_s)
    out = []
    try:
        for i, candidate in enumerate(candidates):
            out.append(tracks.extract_track(
                video, candidate, source, backend,
                window_s=settings.pose_window_s))
            if report and (i + 1) % 25 == 0:
                report.say("pose: %d/%d" % (i + 1, len(candidates)))
    finally:
        backend.close()

    if cache_path:
        os.makedirs(work_dir, exist_ok=True)
        tracks.write_cache(cache_path, out, cache_key)
    if report:
        report.say("pose: %d tracks" % len(out))
    return out


def stage_verify(track_list, settings, report=None):
    """Split tracks into accepted swings and a rejection histogram."""
    accepted, histogram = [], {}
    for track in track_list:
        measured, _ = verify_mod.verify(track, settings)
        if measured.ok:
            accepted.append((track, measured))
        else:
            reason = measured.reason or "no_pose"
            histogram[reason] = histogram.get(reason, 0) + 1

    if report:
        report.say("verify: %d accepted, %d rejected"
                   % (len(accepted), sum(histogram.values())))
        for reason, count in sorted(histogram.items(),
                                    key=lambda kv: -kv[1]):
            report.say("  %-16s %d" % (reason, count))
    return accepted, histogram


def dedupe_swings(accepted, min_gap_s):
    """Collapse accepted swings closer than min_gap_s, keeping the fastest.

    Run after verification rather than before, so a real shot is never
    discarded in favour of a nearby noise that pose would have rejected.
    """
    if not accepted:
        return []
    gap_ms = min_gap_s * 1000.0
    ordered = sorted(accepted, key=lambda pair: pair[0].contact_ms)
    kept = [ordered[0]]
    for track, measured in ordered[1:]:
        if track.contact_ms - kept[-1][0].contact_ms < gap_ms:
            if measured.wrist_peak_speed > kept[-1][1].wrist_peak_speed:
                kept[-1] = (track, measured)
        else:
            kept.append((track, measured))
    return kept


def run(video, outdir, settings, report=None, raw_path=None, limit=0):
    """The whole ETL. Returns the session document."""
    report = report or Reporter(verbose=False)
    source = stage_probe(video, raw_path=raw_path)
    report.say("source: %s %dx%d rot=%d %.1ffps %.1fs"
               % (source["name"], source["width"], source["height"],
                  source["rotation"], source["fps"],
                  source["duration_ms"] / 1000.0))

    root = session.out_root(outdir, video)
    paths = session.paths_for(root)
    os.makedirs(paths["swings"], exist_ok=True)
    existing_dirs = _swing_dirs(paths["swings"])

    candidates = stage_detect(video, settings, report)
    track_list = stage_pose(video, candidates, source, settings,
                            work_dir=paths["work"], report=report)
    accepted, histogram = stage_verify(track_list, settings, report)

    before = len(accepted)
    accepted = dedupe_swings(accepted, settings.min_gap_s)
    if before != len(accepted):
        histogram["duplicate"] = histogram.get("duplicate", 0) + (
            before - len(accepted))
        report.say("dedupe: %d -> %d swings" % (before, len(accepted)))

    # Counted before --limit truncates, so the session document describes
    # the video rather than the slice of it that was rendered. Reporting
    # verified=5 next to candidates=150 read as "145 shots evaporated".
    verified_total = len(accepted)
    if limit:
        accepted = accepted[:limit]

    slots, players_info = players.assign(
        [m for _, m in accepted], mode=settings.player_mode,
        count=settings.player_count)
    report.say("players: %d (%s)" % (players_info["count"],
                                     players_info["mode"]))

    refs = []
    written_dirs = set()
    for index, ((track, measured), slot) in enumerate(zip(accepted, slots), 1):
        dir_name = session.swing_dir_name(index)
        dest = os.path.join(paths["swings"], dir_name)
        rect = crop.rect_for(measured.boxes, source["width"], source["height"],
                             pad_fraction=settings.crop_pad)

        def missing(source_ms, reason, _dir=dir_name):
            report.say("  warning: %s frame at %dms not written: %s"
                       % (_dir, source_ms, reason))

        trim, frames = render.render_swing(video, dest, rect, track.contact_ms,
                                           source, settings,
                                           on_missing=missing)
        _attach_pose_scores(frames, track, measured.slot)
        _write_pose_file(dest, track, measured.slot)

        doc = session.build_swing_doc(
            swing_id="%s/%s" % (os.path.splitext(source["name"])[0], dir_name),
            source=source, trim=trim, crop_rect=rect,
            contact_ms=track.contact_ms, frames=frames,
            measurements=measured.to_metadata(), player_slot=slot,
            onset_peak=track.candidate.get("onset_peak"))
        errors = schema.validate_swing(doc)
        if errors:
            raise RuntimeError("built an invalid swing doc for %s: %s"
                               % (dir_name, errors[:3]))
        session.write_json(os.path.join(dest, "metadata.json"), doc)
        # Probed from disk, not from `doc`: the ETL never writes an `edit`
        # block, so a swing already reviewed by a human is only visible as a
        # user-edit.json sitting next to the metadata we just rewrote.
        refs.append(session.swing_ref(doc, dir_name,
                                      reviewed=session.swing_reviewed(dest)))
        written_dirs.add(dir_name)
        if index % 25 == 0:
            report.say("render: %d/%d" % (index, len(accepted)))

    _report_stale(existing_dirs - written_dirs, paths["swings"], report)

    detection = {"candidates": len(candidates),
                 # The whole video, not the --limit slice of it.
                 "verified": verified_total,
                 "rendered": len(refs),
                 "rejected": sum(histogram.values()),
                 "reject_histogram": histogram}
    doc = session.build_session_doc(source, settings, detection, players_info,
                                    refs)
    errors = schema.validate_session(doc)
    if errors:
        raise RuntimeError("built an invalid session doc: %s" % errors[:3])
    session.write_json(paths["metadata"], doc)
    report.say("wrote %d swings to %s" % (len(refs), root))
    return doc


def _swing_dirs(swings_root):
    """Names of the swing_NNN directories already on disk."""
    try:
        return {name for name in os.listdir(swings_root)
                if name.startswith("swing_")
                and os.path.isdir(os.path.join(swings_root, name))}
    except OSError:
        return set()


def _report_stale(stale, swings_root, report):
    """Warn about swing directories this run did not write.

    Left in place rather than deleted, deliberately. A shorter run -- a
    raised --onset-k, a --limit -- leaves the tail of a previous run behind,
    unreferenced by the new session document but still on disk, and
    `validate` still checks it. Those directories can hold user-edit.json,
    which is human review work and the one thing here that cannot be
    regenerated, so removing them automatically is not the ETL's call.
    """
    if not stale:
        return
    reviewed = sorted(name for name in stale
                      if session.swing_reviewed(os.path.join(swings_root, name)))
    report.say("warning: %d swing directories from an earlier run are not "
               "part of this one (%s)"
               % (len(stale), ", ".join(sorted(stale)[:5])
                  + (", ..." if len(stale) > 5 else "")))
    if reviewed:
        report.say("         %d of them contain user-edit.json: %s"
                   % (len(reviewed), ", ".join(reviewed[:5])
                      + (", ..." if len(reviewed) > 5 else "")))
    report.say("         they are left in place; remove them yourself if "
               "they are not wanted")


def _attach_pose_scores(frames, track, slot):
    """Fill each rendered frame's pose_score from the nearest tracked frame.

    The pose window is narrower than the frame span, so frames at the edges
    legitimately have no pose and keep None.
    """
    series = track.series(slot)
    if not series:
        return
    for frame in frames:
        nearest = min(series, key=lambda row: abs(row[0] - frame["source_ms"]))
        if abs(nearest[0] - frame["source_ms"]) <= 50:
            frame["pose_score"] = round(float(nearest[1].score), 4)


def _write_pose_file(dest, track, slot):
    """Per-frame landmarks beside the frames, in *frame*-normalized space.

    Kept so a future classifier or training run does not need the source
    video re-processed, and so the website can draw a skeleton overlay.

    The space is the full source-display frame, 0..1, which is what the
    `space` field below says and what the tracker produced. It is not the
    crop: to draw these over clip.mp4 or a frame still, map through the
    `crop` rect in metadata.json first. This docstring used to claim
    crop-normalized, contradicting its own payload.

    `measurements` in metadata.json is labelled crop_normalized and is
    unaffected either way -- every value there is a ratio over
    torso_height, so it is identical in both spaces.
    """
    series = track.series(slot)
    session.write_json(os.path.join(dest, "pose.json"), {
        "space": "frame_normalized",
        "origin": "top_left",
        "slot": slot,
        "frames": [{"source_ms": ms, "pose": landmarks.to_json()}
                   for ms, landmarks in series],
    })
