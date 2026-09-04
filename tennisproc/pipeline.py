"""Stage orchestration: candidates -> tracks -> verified swings -> disk.

Each stage is callable on its own and both pose passes cache their output, so
re-rendering never re-runs pose. Re-tuning the DETECTOR does, which is the one
thing that changed when detection went vision-first: the scan is what decides
which windows exist, so every knob upstream of it is in `config._CACHE_KEYS`.
The stages, in order:

    probe    read the source video's facts
    scan     pose over the whole video -> wrist-speed peaks     (cached)
    detect   each peak takes the time of its nearest onset
    pose     one dense track per surviving candidate            (cached)
    verify   accept/reject each candidate, measure the swing
    render   cut clips, extract frames
    index    write the session document

`--no-classify` does not appear here because there is no classifier: stroke
and per-frame stage ship null by design. What this pipeline guarantees is
that every clip, crop, frame and timestamp is produced regardless.
"""

import os

from . import audio, crop, players, probe, render, scan, schema, session, tracks
from .errors import TennisprocError
from . import pose as pose_mod
from . import objects as objects_mod
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


def stage_detect(video, settings, report=None, source=None, work_dir=None):
    """Swing candidates.

    Two detectors. `vision` scans pose across the whole video, takes the peaks
    of wrist speed as swings, and gives each one the timestamp of the nearest
    audio onset -- so the body decides THAT a swing happened and the sound
    decides WHEN. `audio` is the original: every loud transient is a candidate.

    Vision is the default because a body swings once where a room rings
    several times; `scan.py` carries the measurements. `audio` stays reachable
    for a run with no pose backend, and for comparing the two.
    """
    onsets = audio.detect(video, k=settings.onset_k)

    if settings.detector == "audio" or source is None:
        if report:
            report.say("detect: %d audio candidates at k=%.1f"
                       % (len(onsets), settings.onset_k))
        return onsets

    cache_path = os.path.join(work_dir, "scan.jsonl.gz") if work_dir else None
    cache_key = "%s:%s" % (source["sha256_16"], settings.cache_hash())
    samples = scan.read_cache(cache_path, cache_key) if cache_path else None
    if samples is None:
        backend = pose_mod.make_backend(
            settings.pose_backend, model_path=settings.pose_model,
            tiles=settings.pose_tiles,
            min_confidence=settings.pose_min_confidence,
            window_s=settings.pose_window_s)
        samples = tracks.scan_video(video, source, backend,
                                    scan_fps=settings.scan_fps)
        # An empty scan is a failure, not a result: caching it would mean
        # the session is never re-attempted.
        if cache_path and samples:
            os.makedirs(work_dir, exist_ok=True)
            scan.write_cache(cache_path, samples, cache_key)
    elif report:
        report.say("scan: %d pose samples from cache" % len(samples))
    series = scan.wrist_speed_series(samples)
    peaks = scan.find_peaks(series, k=settings.scan_k,
                            min_gap_s=settings.scan_min_gap_s)
    candidates = scan.corroborate(peaks, onsets,
                                  window_s=settings.audio_window_s,
                                  min_gap_s=settings.scan_min_gap_s)
    if report:
        report.say("scan: %d pose samples, %d swing peaks" % (len(samples), len(peaks)))
        report.say("detect: %d candidates (%d peaks had no strike within %.1fs; "
                   "%d audio onsets not on a swing)"
                   % (len(candidates), len(peaks) - len(candidates),
                      settings.audio_window_s, len(onsets) - len(candidates)))
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


def _anchor(pair):
    """The instant a swing is filed under.

    The ANCHORED contact, not the raw onset: a bounce onset and its strike
    onset are far apart as onsets and nearly identical once pose has moved
    both to the swing, which is exactly the pair dedupe should collapse.
    """
    return pair[1].contact_ms if pair[1].contact_ms is not None \
        else pair[0].contact_ms


def _apart_in_torsos(a, b):
    """How far two contacts sit from each other across the court.

    In torso heights, so a pair at the back of the court compares with a pair
    near the camera. Unmeasurable positions return infinity, i.e. "assume two
    different people": the accepted path always sets both fields, and if that
    ever stops being true, shipping a duplicate beats deleting a real swing.
    """
    if a.center_x is None or b.center_x is None:
        return float("inf")
    torso = ((a.torso_height or 0.0) + (b.torso_height or 0.0)) / 2.0
    if torso <= 0:
        return float("inf")
    return abs(a.center_x - b.center_x) / torso


def _strike_confidence(pair):
    """Which of two detections of one swing is the real strike.

    The loudness of the onset the swing is anchored on, in MADs above the
    audio median. A racket strike is the loudest thing in its second; a
    duplicate is anchored on whatever else was audible -- the ball reaching
    the fence, the next ball leaving the machine -- so it is quieter.
    Measured against the 76 feed-slot collisions described in
    `Settings.min_gap_s`, this picks the on-lattice detection 58 times.

    Wrist speed, which this used to decide on alone, picks it 38 times and
    cannot decide at all in 23 of them: `verify.SPEED_CAP` was 40.0 and 1575
    of the 2505 shipped swings (63%) sat exactly on the cap, so "keep the
    fastest" was a coin flip on nearly a third of the pairs. The cap is 150.0
    now and no longer flattens them, but the onset is still the better
    evidence. Speed stays as the tiebreak for a detector run with no onset
    strengths.
    """
    track, measured = pair
    peak = track.candidate.get("onset_peak")
    return (peak if peak is not None else -1.0,
            measured.peak_motion or 0.0)


def dedupe_swings(accepted, min_gap_s, same_place_torsos, pre_s=1.5):
    """Collapse one swing reported twice, keeping the louder strike.

    Two tests, both of which must hold before a pair is collapsed: the
    contacts are closer together than `min_gap_s`, and they happened within
    `same_place_torsos` of each other on court. Together they say "one player
    cannot hit twice that fast", which is true, rather than "no two shots
    happen that close together", which is not -- two players rally as fast as
    1.0s apart. See `Settings.min_gap_s` for both numbers.

    `pre_s` is the window's lead, which decides how far apart a pair can be
    before keeping the LATER of the two would cut the earlier contact out of
    the clip entirely. See the choice below.

    Run after verification rather than before, so a real shot is never
    discarded in favour of a nearby noise that pose would have rejected.
    """
    if not accepted:
        return []
    gap_ms = min_gap_s * 1000.0

    ordered = sorted(accepted, key=_anchor)
    kept = [ordered[0]]
    for pair in ordered[1:]:
        previous = kept[-1]
        same_moment = _anchor(pair) - _anchor(previous) < gap_ms
        same_place = (_apart_in_torsos(previous[1], pair[1])
                      <= same_place_torsos)
        if same_moment and same_place:
            # Which member is the real strike is genuinely uncertain -- every
            # signal on hand lands between 50% and 61% over the feed-slot
            # collisions, which at that sample size is not distinguishable from
            # a coin flip. So the choice is made to be SAFE rather than right:
            # the kept window must still contain the other contact, because a
            # reviewer judges what is on screen, not which millisecond the
            # metadata calls contact.
            #
            # The window is asymmetric -- `pre_s` before, `post_s` after -- so
            # the two choices are not equally safe. Keeping the earlier member
            # covers the other contact for gaps up to `post_s`; keeping the
            # later covers only `pre_s`. Above `pre_s` the later member's
            # window starts AFTER the earlier contact, so if that was the real
            # strike it is not in the clip at all. There the earlier member
            # wins regardless of confidence; below it, confidence decides.
            separation_ms = _anchor(pair) - _anchor(previous)
            later_would_clip = separation_ms > pre_s * 1000.0
            if (not later_would_clip
                    and _strike_confidence(pair) > _strike_confidence(previous)):
                kept[-1] = pair
        else:
            kept.append(pair)
    return kept


def stage_objects(video, accepted, source, settings, report=None):
    """Racket and ball at each accepted swing's contact, or None per swing.

    Never fatal. A missing model, a missing dependency or a frame the decoder
    will not give back costs this block and nothing else -- the swing still
    renders, still carries measurements and still gets reviewed. That is the
    same posture as `stage_proxy`: an extra that must not be able to take the
    session down with it.

    One capture is opened for the whole session rather than one per swing, and
    each swing needs five decodes: the contact frame plus `PLATE_OFFSETS`
    either side of it to build the short background plate.
    """
    if settings.objects_backend in (None, "none"):
        return [None] * len(accepted)
    try:
        backend = objects_mod.make_backend(
            settings.objects_backend,
            **({"weights": settings.objects_weights}
               if settings.objects_backend == "yolo" else {}))
    except TennisprocError as exc:
        if report:
            report.say("objects: skipped (%s)" % exc)
        return [None] * len(accepted)

    import cv2
    step_ms = 1000.0 / float(source["fps"] or 30.0)
    out = []
    found_racket = found_ball = 0
    cap = tracks.open_capture(video, cv2)
    try:
        for track, measured in accepted:
            contact_ms = (measured.contact_ms if measured.contact_ms is not None
                          else track.contact_ms)
            try:
                frame = _frame_at(cap, cv2, contact_ms, source)
                plate = objects_mod.short_plate(
                    [_frame_at(cap, cv2, contact_ms + off * step_ms, source)
                     for off in objects_mod.PLATE_OFFSETS])
            except Exception as exc:            # decoder, not our logic
                if report:
                    report.say("  warning: objects at %dms: %s"
                               % (contact_ms, exc))
                out.append(None)
                continue
            if frame is None or plate is None:
                out.append(None)
                continue
            doc = objects_mod.measure(
                backend, frame, plate,
                _pose_box(track, measured, source),
                _wrists_px(track, measured, source),
                (measured.torso_height or 0.0) * source["height"])
            found_racket += doc["racket"] is not None
            found_ball += doc["ball"] is not None
            out.append(doc)
    finally:
        cap.release()
        backend.close()
    if report:
        report.say("objects: racket on %d/%d swings, ball in flight on %d"
                   % (found_racket, len(accepted), found_ball))
    return out


def _frame_at(cap, cv2, ms, source):
    """One decoded frame at `ms`, in display orientation, or None."""
    if ms < 0 or ms > source["duration_ms"]:
        return None
    cap.set(cv2.CAP_PROP_POS_MSEC, float(ms))
    ok, raw = cap.read()
    if not ok:
        return None
    return tracks.rotate_frame(raw, source.get("rotation", 0), cv2)


def _pose_box(track, measured, source):
    """The measured player's pose bbox, in source-display pixels."""
    series = track.series(measured.slot)
    index = track.nearest_index(track.contact_ms, measured.slot)
    if index is None or not series:
        return None
    x0, y0, x1, y1 = series[index][1].bbox()
    return objects_mod.Box(x0 * source["width"], y0 * source["height"],
                           x1 * source["width"], y1 * source["height"])


def _wrists_px(track, measured, source):
    """Both wrists, in source-display pixels.

    Both, not the hitting one: nothing decides which arm swung any more, and a
    racket beside either hand is this player's regardless.
    """
    series = track.series(measured.slot)
    index = track.nearest_index(track.contact_ms, measured.slot)
    if index is None or not series:
        return ()
    landmarks = series[index][1]
    return tuple((landmarks.xy(w)[0] * source["width"],
                  landmarks.xy(w)[1] * source["height"])
                 for w in (pose_mod.L_WRIST, pose_mod.R_WRIST))


def stage_proxy(video, root, settings, report=None):
    """Transcode the whole source once, for the review app to seek in.

    Returns the proxy block, or None when one was not produced. Never fatal:
    the swings, their frames and every timestamp are already on disk by the
    time this runs, and a session that cannot be transcoded is still a
    reviewable session -- it just falls back to per-swing clips. Losing a whole
    run's detection work to a codec problem at the last step would be the worse
    trade.
    """
    if not settings.proxy:
        return None

    dest = os.path.join(root, session.PROXY_FILE)
    try:
        info = render.build_proxy(video, dest,
                                  crf=settings.proxy_crf,
                                  height=settings.proxy_height,
                                  fps=settings.proxy_fps)
    except (TennisprocError, OSError) as exc:
        if report:
            report.say("proxy: skipped (%s)" % exc)
        return None

    if report:
        report.say("proxy: %s %dx%d %.1ffps %.0fMB"
                   % (info["file"], info["width"], info["height"],
                      info["fps"], info["bytes"] / 1e6))
    return info


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

    candidates = stage_detect(video, settings, report, source=source,
                              work_dir=paths["work"])
    track_list = stage_pose(video, candidates, source, settings,
                            work_dir=paths["work"], report=report)
    accepted, histogram = stage_verify(track_list, settings, report)

    before = len(accepted)
    accepted = dedupe_swings(accepted, settings.min_gap_s,
                             settings.same_place_torsos,
                             pre_s=settings.pre_s)
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

    object_docs = stage_objects(video, accepted, source, settings, report)

    refs = []
    written_dirs = set()
    for index, ((track, measured), slot) in enumerate(zip(accepted, slots), 1):
        dir_name = session.swing_dir_name(index)
        dest = os.path.join(paths["swings"], dir_name)
        # See `Settings.crop_mode`: the pose rect frames where the player stood
        # during the pose window, which is a fifth of what gets rendered.
        if settings.crop_mode == "pose":
            rect = crop.rect_for(measured.boxes, source["width"],
                                 source["height"],
                                 pad_fraction=settings.crop_pad)
        else:
            rect = crop.full_frame(source["width"], source["height"])

        def missing(source_ms, reason, _dir=dir_name):
            report.say("  warning: %s frame at %dms not written: %s"
                       % (_dir, source_ms, reason))

        # The anchored contact, which is the audio onset unless pose moved it.
        # Everything a reviewer sees hangs off this: the clip is centred on it
        # and every frame's `offset_contact_ms` is measured from it.
        contact_ms = (measured.contact_ms if measured.contact_ms is not None
                      else track.contact_ms)
        trim, frames = render.render_swing(video, dest, rect, contact_ms,
                                           source, settings,
                                           on_missing=missing)
        _attach_pose_scores(frames, track, measured.slot)
        _write_pose_file(dest, track, measured.slot)

        doc = session.build_swing_doc(
            swing_id="%s/%s" % (os.path.splitext(source["name"])[0], dir_name),
            source=source, trim=trim, crop_rect=rect,
            contact_ms=contact_ms, frames=frames,
            measurements=measured.to_metadata(), player_slot=slot,
            onset_peak=track.candidate.get("onset_peak"),
            # `audio` alone is no longer true for a re-anchored swing: the
            # instant came from the wrist-speed peak, and the onset only said
            # where to look. Recorded so a reader can tell the two apart --
            # audio locates contact to about +-20ms, pose to a frame.
            method=("audio_onset+pose_contact" if measured.reanchored
                    else "audio_onset+pose_verify"),
            onset_ms=track.contact_ms if measured.reanchored else None,
            objects=object_docs[index - 1])
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
    proxy = stage_proxy(video, root, settings, report)
    doc = session.build_session_doc(source, settings, detection, players_info,
                                    refs, proxy=proxy)
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

    # The schema asserts that non-null measurements imply *some* frame carries
    # a score, and it is right to: the two blocks otherwise disagree about
    # whether pose ran. But 50 ms is a native-fps assumption. At `--fps 2` the
    # stills are 500 ms apart, so the whole +-400 ms pose window can fall
    # between two of them and nothing lands within 50 ms -- a perfectly good
    # swing then renders as an invalid document and aborts the session, which
    # is how IMG_0305/swing_105 killed a 121-swing render at 100.
    #
    # The nearest still to the track IS the one the measurements describe, so
    # it adopts the nearest sample whatever the gap. Deliberately last-resort:
    # it fires only when the loop above scored nothing, so at native fps this
    # is unreachable and every frame's score still means what it always did.
    if frames and all(frame["pose_score"] is None for frame in frames):
        gap = lambda frame: min(abs(row[0] - frame["source_ms"]) for row in series)
        closest = min(frames, key=gap)
        nearest = min(series, key=lambda row: abs(row[0] - closest["source_ms"]))
        closest["pose_score"] = round(float(nearest[1].score), 4)


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
