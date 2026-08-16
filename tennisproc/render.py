"""Write the clip and the frame stills for one swing.

Two ffmpeg jobs per swing:

  * `clip.mp4` -- a few seconds of context around contact, cropped to the
    player, re-encoded. Re-encoded rather than stream-copied because a copy
    can only cut at a keyframe, which would put the clip's start up to a
    keyframe interval away from where the metadata says it is.
  * `frames/frame_NNNN.jpg` -- a dense run of stills around contact, cropped
    and scaled, extracted in one pass with the fps filter.

Frames are extracted at the *source* frame rate by default. A human
relabelling the true contact frame cannot do it on a sparse grid: at 30 fps
one frame is 33 ms and the ball moves feet between them. That density is the
main size driver, roughly 2-4 MB per swing.

Filenames are plain indices. The previous code encoded the time offset into
each name (`f+0.00s.jpg`) and parsed it back out, which made filenames
load-bearing and forced numeric re-sorting because `f+0.00s.jpg` sorts before
`f-1.20s.jpg`. Here `metadata.json` owns every timestamp.
"""

import os
import subprocess

from . import crop as crop_mod
from . import probe as probe_mod


class RenderError(RuntimeError):
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
    """Clip start and end in ms, clamped to the video."""
    start = max(0, int(round(contact_ms - pre_s * 1000)))
    end = min(int(duration_ms), int(round(contact_ms + post_s * 1000)))
    if end <= start:
        end = min(int(duration_ms), start + 1)
    return start, end


def frame_times_ms(contact_ms, span_s, fps, duration_ms):
    """Timestamps for the frame stills, centred on contact.

    Contact itself is always on the grid -- the times are built outward from
    it -- so the frame a human will call "contact" exists to be labelled.
    """
    if fps <= 0:
        return [int(contact_ms)]
    step_ms = 1000.0 / fps
    half = max(1, int(round((span_s / 2.0) / (step_ms / 1000.0))))
    times = []
    for i in range(-half, half + 1):
        t = int(round(contact_ms + i * step_ms))
        if 0 <= t <= duration_ms:
            times.append(t)
    return times or [int(min(max(0, contact_ms), duration_ms))]


def cut_clip(video, dest, rect, start_ms, end_ms, height=480, crf=26):
    """Cut and crop one clip. Returns (path, width, height, encoded_start_ms).

    `-ss` before `-i` seeks quickly; the re-encode means the result starts
    exactly where asked rather than at the previous keyframe.
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


def extract_frames(video, dest_dir, rect, times_ms, long_edge=640, quality=88):
    """Write one JPEG per timestamp. Returns [(index, filename, source_ms)].

    Each still is seeked individually rather than filtered as a stream: the
    grid must land on exact timestamps that metadata.json can record, and an
    fps filter would drift off them.
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
        _run(["ffmpeg", "-v", "error",
              "-ss", "%.3f" % (source_ms / 1000.0),
              "-i", str(video),
              "-frames:v", "1", "-vf", vf, "-q:v", str(qv),
              "-y", path])
        if os.path.exists(path):
            written.append((index, name, source_ms))
    return written


def render_swing(video, dest_dir, rect, contact_ms, source, settings):
    """Render one swing's clip and frames.

    Returns (trim_block, [frame_records]) ready for a SwingDoc. Frame records
    carry `source_ms` as identity and `offset_contact_ms` measured from the
    detector's contact time, which the ETL owns and never rewrites -- so a
    human moving contact later cannot leave 49 stale offsets behind.
    """
    os.makedirs(dest_dir, exist_ok=True)
    start_ms, end_ms = clip_bounds(contact_ms, settings.pre_s, settings.post_s,
                                   source["duration_ms"])

    trim = cut_clip(video, os.path.join(dest_dir, "clip.mp4"), rect,
                    start_ms, end_ms, height=settings.clip_height,
                    crf=settings.clip_crf)

    fps = settings.frame_fps or source["fps"]
    times = frame_times_ms(contact_ms, settings.frame_span_s, fps,
                           source["duration_ms"])
    written = extract_frames(video, os.path.join(dest_dir, "frames"), rect,
                             times, long_edge=settings.frame_long_edge,
                             quality=settings.frame_quality)

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
