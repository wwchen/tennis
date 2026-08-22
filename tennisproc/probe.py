"""ffprobe wrapper: source video facts, including the rotation mess.

Rotation is the subtlest thing in this file. Three separate conventions are
in play, all verified against the ffmpeg/OpenCV in this environment:

  * ffprobe reports rotation in `side_data_list` as a Display Matrix, and
    reports a quarter-turn as **-90**, not 270.
  * OpenCV reports the same video's CAP_PROP_ORIENTATION_META as **270** --
    the opposite sign convention.
  * A stream's `width`/`height` are the *coded* dimensions. For a 90/270
    rotation the display dimensions are swapped, which is why a portrait
    iPhone .MOV probes as 1920x1080.

Everything downstream uses one convention: `rotation` is clockwise degrees
in {0, 90, 180, 270} needed to get from coded to display orientation, and
`width`/`height` are *display* dimensions. tracks.py rotates decoded frames
itself rather than trusting a library default, because OpenCV 5.0 auto-rotates
(CAP_PROP_ORIENTATION_AUTO defaults to 1) while older versions did not --
the previous generation of this code was written against one that did not.
"""

import datetime
import hashlib
import json
import os
import shutil
import subprocess

from .errors import TennisprocError

FINGERPRINT_CHUNK = 8 * 1024 * 1024


class ProbeError(TennisprocError):
    pass


def require_tools():
    missing = [t for t in ("ffmpeg", "ffprobe") if not shutil.which(t)]
    if missing:
        raise ProbeError("not on PATH: %s" % ", ".join(missing))


def _run_ffprobe(path):
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json",
           "-show_streams", "-show_format", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, check=True).stdout
    except subprocess.CalledProcessError as exc:
        raise ProbeError("ffprobe failed on %s: %s"
                         % (path, exc.stderr.decode("utf-8", "replace")))
    return json.loads(out)


def _normalize_rotation(degrees):
    """Any signed rotation -> clockwise degrees in {0, 90, 180, 270}."""
    return int(round(degrees)) % 360


def _stream_rotation(stream):
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            return _normalize_rotation(-float(side["rotation"]))
    tag = (stream.get("tags") or {}).get("rotate")
    if tag is not None:
        try:
            return _normalize_rotation(float(tag))
        except (TypeError, ValueError):
            pass
    return 0


def _parse_fraction(value):
    if not value:
        return 0.0
    if "/" in str(value):
        num, _, den = str(value).partition("/")
        try:
            num, den = float(num), float(den)
        except ValueError:
            return 0.0
        return num / den if den else 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def fingerprint(path):
    """Identity for a large file without hashing all of it.

    Size plus the first and last 8 MB. A re-encode or a trim changes both
    ends; two different sessions from the same camera will not collide.
    """
    size = os.path.getsize(path)
    h = hashlib.sha256()
    h.update(str(size).encode("ascii"))
    with open(path, "rb") as fh:
        h.update(fh.read(FINGERPRINT_CHUNK))
        if size > FINGERPRINT_CHUNK * 2:
            fh.seek(-FINGERPRINT_CHUNK, os.SEEK_END)
            h.update(fh.read(FINGERPRINT_CHUNK))
    return h.hexdigest()[:16]


def _modified_iso(path):
    """The file's mtime as an ISO 8601 UTC string, or None if it has none."""
    try:
        stamp = os.path.getmtime(path)
    except OSError:
        return None
    return datetime.datetime.utcfromtimestamp(stamp).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def probe(path, raw_path=None):
    """Return the `source` block of a SwingDoc/SessionDoc.

    raw_path: what to record in `path` (the user's argument, ~ preserved);
    defaults to the resolved path actually opened.
    """
    require_tools()
    if not os.path.exists(path):
        raise ProbeError("no such file: %s" % path)

    data = _run_ffprobe(path)
    videos = [s for s in data.get("streams", [])
              if s.get("codec_type") == "video"]
    if not videos:
        raise ProbeError("no video stream in %s" % path)
    video = videos[0]
    audios = [s for s in data.get("streams", [])
              if s.get("codec_type") == "audio"]

    rotation = _stream_rotation(video)
    coded_w = int(video.get("width") or 0)
    coded_h = int(video.get("height") or 0)
    if not coded_w or not coded_h:
        raise ProbeError("could not read frame size from %s" % path)
    # Display dimensions: a quarter turn swaps them.
    width, height = ((coded_h, coded_w) if rotation in (90, 270)
                     else (coded_w, coded_h))

    fps = _parse_fraction(video.get("avg_frame_rate"))
    r_fps = _parse_fraction(video.get("r_frame_rate"))
    if not fps:
        fps = r_fps
    if not fps:
        raise ProbeError("could not read frame rate from %s" % path)
    # avg != r means timestamps are not evenly spaced. Frame *numbers* are
    # then meaningless, which is why frame identity downstream is source_ms.
    vfr = bool(r_fps and abs(r_fps - fps) > 0.01)

    duration_s = (_parse_fraction(video.get("duration"))
                  or _parse_fraction((data.get("format") or {}).get("duration")))
    if not duration_s:
        raise ProbeError("could not read duration from %s" % path)

    audio_sr = None
    if audios:
        try:
            audio_sr = int(audios[0].get("sample_rate"))
        except (TypeError, ValueError):
            audio_sr = None

    return {
        "name": os.path.basename(path),
        "path": str(raw_path if raw_path is not None else path),
        "sha256_16": fingerprint(path),
        "bytes": os.path.getsize(path),
        # When the footage was shot, as far as the filesystem knows. The
        # container's own creation tag would be better, but it survives neither
        # AirDrop nor a copy off the phone, while mtime does. Recorded rather
        # than left to the reader because `source` is copied into every swing
        # precisely so a swing directory can say where it came from, and "which
        # afternoon was this" is part of that.
        "modified": _modified_iso(path),
        "duration_ms": int(round(duration_s * 1000)),
        "fps": round(fps, 6),
        "vfr": vfr,
        "width": width,
        "height": height,
        "rotation": rotation,
        "has_audio": bool(audios),
        "audio_sr": audio_sr,
    }


def coded_size(source):
    """Coded (pre-rotation) frame size, for interpreting raw cv2 frames."""
    if source["rotation"] in (90, 270):
        return source["height"], source["width"]
    return source["width"], source["height"]


def probe_clip_start_ms(path):
    """First frame's presentation timestamp, in ms.

    The written clip's start is *probed* rather than assumed: a stream-copy
    cut snaps to the previous keyframe, so the requested and actual starts
    can differ by up to a keyframe interval.
    """
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json",
           "-select_streams", "v:0", "-show_entries",
           "packet=pts_time,dts_time", "-read_intervals", "%+#1", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, check=True).stdout
    except subprocess.CalledProcessError:
        return None
    for packet in (json.loads(out).get("packets") or []):
        for key in ("pts_time", "dts_time"):
            if packet.get(key) is not None:
                try:
                    return int(round(float(packet[key]) * 1000))
                except (TypeError, ValueError):
                    continue
    return None
