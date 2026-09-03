"""Write the clip and the frame stills for one swing.

Two ffmpeg jobs per swing:

  * `clip.mp4` -- a few seconds of context around contact, re-encoded.
    Re-encoded rather than stream-copied because a copy can only cut at a
    keyframe, which would put the clip's start up to a keyframe interval away
    from where the metadata says it is.
  * `frames/frame_NNNN.jpg` -- a run of stills around contact, scaled,
    extracted in one pass with the fps filter.

Both go through the same rect, which is the whole frame unless
`crop_mode="pose"` was asked for.

Frames are extracted at the *source* frame rate by DEFAULT, which is the
density a human needs to relabel the true contact frame: at 30 fps one frame
is 33 ms and the ball moves feet between them. It is also the main size
driver, roughly 2-4 MB per swing, and `scripts/process.sh` therefore ships
`--fps 2 --span 3.0` instead -- 7 stills half a second apart, about 300 KB a
swing, wide enough to read a whole swing. Contact is still on the grid either
way (see `frame_times_ms`), but at 0.5s spacing there is no neighbouring frame
to move the label to. Neither setting is right for both jobs.

Filenames are plain indices. The previous code encoded the time offset into
each name (`f+0.00s.jpg`) and parsed it back out, which made filenames
load-bearing and forced numeric re-sorting because `f+0.00s.jpg` sorts before
`f-1.20s.jpg`. Here `metadata.json` owns every timestamp.
"""

import os
import subprocess

from . import crop as crop_mod
from . import probe as probe_mod
from .errors import TennisprocError


class RenderError(TennisprocError):
    pass


def _crop_filter(rect):
    return "crop=%d:%d:%d:%d" % (rect["w"], rect["h"], rect["x"], rect["y"])


def _run(cmd):
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RenderError("ffmpeg failed: %s"
                          % result.stderr.decode("utf-8", "replace").strip())
    return result


def clip_bounds(contact_ms, pre_s, post_s, duration_ms):
    """Clip start and end in ms: a fixed window, clamped to the video.

    Every clip is the same `pre_s + post_s` around its contact, deliberately.
    Splitting the session at the midpoint between neighbouring contacts was
    tried and reverted: it removed all overlap, but made a clip's length a
    function of how fast the rally was going -- 1.2s in an exchange, 3.5s off a
    feed -- and truncated follow-throughs that genuinely run into the next shot.

    Overlap between neighbours is therefore expected and fine: two shots 2s
    apart share about 43% of their video and are still plainly different swings.
    What is NOT fine is two contacts a fifth of a second apart yielding the same
    clip twice, and that is `min_gap_s`' job, upstream in `dedupe_swings`.
    """
    start = max(0, int(round(contact_ms - pre_s * 1000)))
    end = min(int(duration_ms), int(round(contact_ms + post_s * 1000)))


    if end <= start:
        end = min(int(duration_ms), start + 1)
    return start, end


def frame_times_ms(contact_ms, span_s, fps, duration_ms):
    """Timestamps for the frame stills, centred on contact.

    Contact itself is always on the grid -- the times are built outward from
    it -- so the frame a human will call "contact" exists to be labelled.

    The upper bound is the last frame's presentation time, not the duration.
    A video runs for `duration` but its final frame starts one interval
    earlier, and asking ffmpeg for a timestamp inside that trailing gap
    yields no frame at all -- which used to abort an entire run on a swing
    near the end of a session.
    """
    if fps <= 0:
        return [int(contact_ms)]
    step_ms = 1000.0 / fps
    last_ms = max(0, int(duration_ms) - int(step_ms))
    half = max(1, int(round((span_s / 2.0) / (step_ms / 1000.0))))
    times = []
    for i in range(-half, half + 1):
        t = int(round(contact_ms + i * step_ms))
        if 0 <= t <= last_ms:
            times.append(t)
    return times or [int(min(max(0, contact_ms), last_ms))]


def cut_clip(video, dest, rect, start_ms, end_ms, height=0, crf=26):
    """Cut and crop one clip. Returns (path, width, height, encoded_start_ms).

    `-ss` before `-i` seeks quickly; the re-encode means the result starts
    exactly where asked rather than at the previous keyframe.

    `height=0` (the default) keeps the crop's own resolution: only the even-
    dimension truncation yuv420p requires is applied. fps is left alone too --
    no `-r` is ever passed, so the clip inherits the source's frame rate.
    """
    duration_s = (end_ms - start_ms) / 1000.0
    # Never upscale: a crop shorter than the target height is left alone
    # rather than blown up, which would spend bytes without adding detail.
    if height and rect["h"] > height:
        scale = "scale=-2:%d" % height
    else:
        scale = "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    vf = "%s,%s,format=yuv420p" % (_crop_filter(rect), scale)
    _run(["ffmpeg", "-v", "error",
          "-ss", "%.3f" % (start_ms / 1000.0),
          "-i", str(video),
          "-t", "%.3f" % duration_s,
          "-vf", vf,
          "-c:v", "libx264", "-profile:v", "high", "-crf", str(crf),
          "-preset", "veryfast", "-movflags", "+faststart",
          "-an", "-y", str(dest)])
    if not os.path.exists(dest):
        raise RenderError("clip not written: %s" % dest)

    info = probe_mod.probe(dest)
    encoded_start = probe_mod.probe_clip_start_ms(dest)
    return {
        "file": os.path.basename(str(dest)),
        "source_start_ms": int(start_ms),
        "source_end_ms": int(end_ms),
        # Probed, not assumed: what the file actually starts at.
        "encoded_start_ms": int(start_ms + (encoded_start or 0)),
        "width": info["width"],
        "height": info["height"],
    }


def extract_frames(video, dest_dir, rect, times_ms, long_edge=640, quality=88,
                   on_missing=None):
    """Write one JPEG per timestamp. Returns [(index, filename, source_ms)].

    Each still is seeked individually rather than filtered as a stream: the
    grid must land on exact timestamps that metadata.json can record, and an
    fps filter would drift off them.

    A still that cannot be produced is skipped, not fatal. One unreadable
    timestamp near the end of a session used to raise out of the whole ETL
    after 297 swings had already been rendered, losing the session document
    with it -- a gap in one frame grid is not worth that. `on_missing` is
    called with (source_ms, reason) for each, so the skip is reported rather
    than silent: ffmpeg can exit 0 having written nothing at all, which is
    exactly the yuvj420p failure noted above.
    """
    os.makedirs(dest_dir, exist_ok=True)
    out_w, out_h = crop_mod.scale_to_long_edge(rect["w"], rect["h"], long_edge)
    # yuvj420p, not yuv420p: the MJPEG encoder refuses non-full-range YUV
    # ("Non full-range YUV is non-standard") and writes nothing at all.
    vf = "%s,scale=%d:%d,format=yuvj420p" % (_crop_filter(rect), out_w, out_h)
    # ffmpeg's -q:v is 2 (best) to 31 (worst); map from a 1-100 quality.
    qv = max(2, min(31, int(round(31 - (quality / 100.0) * 29))))

    written = []
    for index, source_ms in enumerate(times_ms):
        name = "frame_%04d.jpg" % index
        path = os.path.join(dest_dir, name)
        try:
            _run(["ffmpeg", "-v", "error",
                  "-ss", "%.3f" % (source_ms / 1000.0),
                  "-i", str(video),
                  "-frames:v", "1", "-vf", vf, "-q:v", str(qv),
                  "-y", path])
        except RenderError as exc:
            if on_missing:
                on_missing(source_ms, str(exc))
            continue
        if os.path.exists(path):
            written.append((index, name, source_ms))
        elif on_missing:
            on_missing(source_ms, "ffmpeg exited 0 but wrote no file")
    return written


def render_swing(video, dest_dir, rect, contact_ms, source, settings,
                 on_missing=None):
    """Render one swing's clip and frames.

    Returns (trim_block, [frame_records]) ready for a SwingDoc. Frame records
    carry `source_ms` as identity and `offset_contact_ms` measured from the
    detector's contact time, which the ETL owns and never rewrites -- so a
    human moving contact later cannot leave 49 stale offsets behind.

    `on_missing(source_ms, reason)` is forwarded to extract_frames; a still
    that cannot be produced is skipped and reported, never fatal.
    """
    os.makedirs(dest_dir, exist_ok=True)
    start_ms, end_ms = clip_bounds(contact_ms, settings.pre_s, settings.post_s,
                                   source["duration_ms"])

    # One rect for the clip and the stills, so `crop` in the document describes
    # what was actually rendered. Which rect that is, and why it defaults to the
    # whole frame, is `Settings.crop_mode`.
    trim = cut_clip(video, os.path.join(dest_dir, "clip.mp4"), rect,
                    start_ms, end_ms, height=settings.clip_height,
                    crf=settings.clip_crf)

    fps = settings.frame_fps or source["fps"]
    times = frame_times_ms(contact_ms, settings.frame_span_s, fps,
                           source["duration_ms"])

    written = extract_frames(video, os.path.join(dest_dir, "frames"), rect,
                             times, long_edge=settings.frame_long_edge,
                             quality=settings.frame_quality,
                             on_missing=on_missing)

    frames = []
    for _, name, source_ms in written:
        frames.append({
            "file": "frames/%s" % name,
            "source_ms": int(source_ms),
            "clip_ms": int(source_ms - start_ms),
            "offset_contact_ms": int(source_ms - contact_ms),
            "pose_score": None,
            "stage": None,
        })
    return trim, frames
