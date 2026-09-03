"""Assemble and write the output tree.

Two document builders and the file layout. Nothing here decides anything --
detection, verification, cropping and rendering have all happened by the time
these functions are called; this module's only job is to lay the results out
on disk in the shape the schema promises.

Writes are atomic (temp file then rename) because the review website may be
reading a document while a re-run rewrites it, and a half-written JSON file
would look like corruption rather than a race.
"""

import json
import os
import tempfile

from . import schema

SWINGS_DIR = "swings"

# The full-length playable transcode, at the session root beside metadata.json.
# One per session, not per swing: it IS the session's video.
PROXY_FILE = "source.mp4"
WORK_DIR = "work"


def swing_dir_name(index):
    """swing_001, swing_002, ... Three digits sorts correctly to 999."""
    return "swing_%03d" % index


def write_json(path, data):
    """Atomically write JSON, so a reader never sees a partial file."""
    directory = os.path.dirname(str(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1, sort_keys=False)
            fh.write("\n")
        os.replace(tmp, str(path))
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_json(path):
    try:
        with open(str(path), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def build_swing_doc(swing_id, source, trim, crop_rect, contact_ms, frames,
                    measurements=None, player_slot=None, onset_peak=None,
                    verified=True, reject_reason=None,
                    method="audio_onset+pose_verify", onset_ms=None):
    """One swing's metadata.json.

    `source` is denormalized into every swing rather than referenced, so a
    swing directory can be shipped to a labeller or into a training set and
    still say what video it came from. The source videos this project's
    earlier output was built from are already gone, which is the argument.
    """
    return {
        "schema": schema.SWING_SCHEMA,
        "id": swing_id,
        "source": dict(source),
        "trim": dict(trim),
        "crop": dict(crop_rect),
        "detection": {
            "method": method,
            # Where the ETL says contact happened. Never rewritten *by a human*:
            # moving contact is an edit in user-edit.json, so every frame's
            # offset_contact_ms stays meaningful against this.
            #
            # Usually the audio onset, which locates a strike to about +-20ms.
            # When the onset turned out to be a bounce and pose found the swing
            # a third of a second later, this is the wrist-speed peak instead
            # and `method` says so -- see `measure_slot`. `onset_ms` then keeps
            # the sound that started the search, so the two never merge into one
            # unattributable number.
            "contact_ms": int(contact_ms),
            "onset_ms": None if onset_ms is None else int(onset_ms),
            "onset_peak": onset_peak,
            "verified": bool(verified),
            "reject_reason": reject_reason,
        },
        "labels": schema.new_labels(player_slot=player_slot),
        "frames": list(frames),
        "measurements": measurements,
        "edit": None,
    }


def build_session_doc(source, settings, detection, players_info, swing_refs,
                      proxy=None):
    """The session metadata.json: one fetch for a whole session.

    `proxy` describes the full-length playable transcode the review app seeks
    in, or is None when there is none -- an older tree, or a session whose
    source video is gone. It is written as an explicit null rather than
    omitted, so a reader can tell "this ETL had no proxy to offer" from "this
    document predates proxies" without consulting the schema version.
    """
    return {
        "schema": schema.SESSION_SCHEMA,
        "source": dict(source),
        "settings": settings.as_metadata(),
        "detection": dict(detection),
        "players": dict(players_info),
        "proxy": dict(proxy) if proxy else None,
        "swings": list(swing_refs),
    }


def swing_ref(doc, dir_name, reviewed=None):
    """The compact index entry for a swing.

    Deliberately small: a 300-swing session should render from one fetch,
    not 300.

    `reviewed` must be passed in, because the ETL cannot know it: the ETL
    only ever writes metadata.json, whose `edit` block is null by
    construction. Deriving it from `doc` -- which is what this used to do --
    left the field permanently false, so a consumer had to stat all 300
    directories anyway, which is the exact cost this index exists to avoid.
    `swing_reviewed()` computes it from the output tree.
    """
    trim = doc["trim"]
    return {
        "id": doc["id"],
        "dir": "%s/%s" % (SWINGS_DIR, dir_name),
        "contact_ms": doc["detection"]["contact_ms"],
        "duration_ms": trim["source_end_ms"] - trim["source_start_ms"],
        "player_slot": doc["labels"].get("player_slot"),
        "frame_count": len(doc["frames"]),
        "verified": doc["detection"]["verified"],
        "reviewed": (bool(doc.get("edit")) if reviewed is None
                     else bool(reviewed)),
    }


def swing_reviewed(swing_dir):
    """True when a human has left a user-edit.json in this swing directory."""
    return os.path.exists(os.path.join(str(swing_dir), "user-edit.json"))


def out_root(outdir, video_path):
    stem = os.path.splitext(os.path.basename(str(video_path)))[0]
    return os.path.join(str(outdir), stem)


def paths_for(root):
    return {
        "root": root,
        "metadata": os.path.join(root, "metadata.json"),
        "work": os.path.join(root, WORK_DIR),
        "swings": os.path.join(root, SWINGS_DIR),
    }


def load_swing(swing_path):
    """Read a swing's metadata.json overlaid with its user-edit.json.

    This is what a consumer should use: the merged view, with human labels
    winning and frames joined on source_ms.
    """
    metadata = read_json(os.path.join(swing_path, "metadata.json"))
    if metadata is None:
        return None, []
    user_edit = read_json(os.path.join(swing_path, "user-edit.json"))
    warnings = []
    merged = schema.overlay(metadata, user_edit, warn=warnings.append,
                            metadata_hash=schema.doc_hash(metadata))
    return merged, warnings


def validate_tree(root):
    """Validate every document under an output root.

    Returns (checked_count, [(path, [errors])]).
    """
    problems = []
    checked = 0

    session_path = os.path.join(root, "metadata.json")
    session = read_json(session_path)
    checked += 1
    if session is None:
        problems.append((session_path, ["unreadable or missing"]))
    else:
        errors = schema.validate_session(session)
        if errors:
            problems.append((session_path, errors))

    swings_root = os.path.join(root, SWINGS_DIR)
    if os.path.isdir(swings_root):
        for name in sorted(os.listdir(swings_root)):
            swing_path = os.path.join(swings_root, name)
            if not os.path.isdir(swing_path):
                continue
            for filename in ("metadata.json", "user-edit.json"):
                path = os.path.join(swing_path, filename)
                if not os.path.exists(path):
                    continue
                checked += 1
                doc = read_json(path)
                if doc is None:
                    problems.append((path, ["unreadable JSON"]))
                    continue
                errors = schema.validate_swing(doc)
                # Referenced files must exist, or the website shows gaps.
                for frame in (doc.get("frames") or []):
                    if not os.path.exists(os.path.join(swing_path,
                                                       frame.get("file", ""))):
                        errors.append("missing frame file: %s"
                                      % frame.get("file"))
                clip = (doc.get("trim") or {}).get("file")
                if clip and not os.path.exists(os.path.join(swing_path, clip)):
                    errors.append("missing clip file: %s" % clip)
                if errors:
                    problems.append((path, errors))

    return checked, problems
