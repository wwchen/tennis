"""DTOs, enums, validator, and the metadata/user-edit overlay.

One document shape, `SwingDoc`, is written to two files:

    swings/swing_NNN/metadata.json   the ETL's output; label fields null
    swings/swing_NNN/user-edit.json  the same document, human fields filled

Reading a swing means `overlay(metadata, user_edit)`. Keeping them separate
lets the ETL be re-run at any time without destroying human work, since it
only ever writes metadata.json.

Enums live here and nowhere else. The previous generation of this codebase
had four overlapping FIELDS constants in four modules, two of which had
drifted out of sync, so every consumer needs to import from one place.

Validation is hand-written because jsonschema is not installable in this
environment (no network). It returns a list of human-readable error strings
rather than raising, so a caller can report every problem in a document at
once instead of one per run.
"""

import hashlib
import json

SWING_SCHEMA = "tennis.swing/1"
SESSION_SCHEMA = "tennis.session/1"
USER_EDIT_SCHEMA = SWING_SCHEMA  # same shape, deliberately

STAGES = ("setup", "contact", "finish", "other")

# Coarse on purpose. Ganser et al. (Sensors 2021, PMC8433919) reached only
# F1 72-80% separating slice from topspin with a 1660 Hz wrist IMU; at 30 fps
# it is not recoverable, so spin is not in the vocabulary. `overhead` is
# separate from `serve` because an overhead off a fed ball is neither.
STROKES = ("forehand", "backhand", "volley", "serve", "overhead", "other")

VERDICTS = ("valid", "false_positive", "duplicate", "unclear")
PLAYER_SLOTS = ("left", "right", "near", "far")
PLAYER_MODES = ("side", "depth")
QUALITY = (1, 2, 3, 4, 5)

REJECT_REASONS = ("no_pose", "torso_too_small", "no_wrist_track",
                  "wrist_too_slow", "onset_off_swing", "duplicate")

CROP_SPACE = "source_display"
MEASURE_SPACE = "crop_normalized"
MEASURE_ORIGIN = "top_left"
HITTING_SIDES = ("left", "right")
ROTATIONS = (0, 90, 180, 270)

# Blocks the ETL owns outright. A stale user-edit.json must never be able to
# rewrite where a clip came from.
ETL_OWNED = ("source", "trim", "crop", "detection", "measurements")

_INT = (int,)
_NUM = (int, float)


def _is(value, types):
    # bool is a subclass of int; never let True pass as an integer field.
    if isinstance(value, bool) and bool not in types:
        return False
    return isinstance(value, types)


class _Check:
    """Accumulates dotted-path error strings for one document."""

    def __init__(self):
        self.errors = []

    def add(self, path, msg):
        self.errors.append("%s: %s" % (path, msg))

    def block(self, doc, name, path):
        """Require a dict-valued field; return it or None."""
        if name not in doc:
            self.add("%s.%s" % (path, name), "missing")
            return None
        value = doc[name]
        if not isinstance(value, dict):
            self.add("%s.%s" % (path, name), "expected object, got %s"
                     % type(value).__name__)
            return None
        return value

    def field(self, doc, name, path, types, optional=False, enum=None,
              positive=False, non_negative=False):
        if name not in doc:
            self.add("%s.%s" % (path, name), "missing")
            return None
        value = doc[name]
        where = "%s.%s" % (path, name)
        if value is None:
            if not optional:
                self.add(where, "must not be null")
            return None
        if not _is(value, types):
            self.add(where, "expected %s, got %s"
                     % ("/".join(t.__name__ for t in types),
                        type(value).__name__))
            return None
        if enum is not None and value not in enum:
            self.add(where, "%r not one of %s" % (value, list(enum)))
            return None
        if positive and value <= 0:
            self.add(where, "must be > 0, got %r" % (value,))
        if non_negative and value < 0:
            self.add(where, "must be >= 0, got %r" % (value,))
        return value

    def const(self, doc, name, path, expected):
        value = self.field(doc, name, path, (str,))
        if value is not None and value != expected:
            self.add("%s.%s" % (path, name),
                     "expected %r, got %r" % (expected, value))


def _check_source(c, src, path):
    c.field(src, "name", path, (str,))
    c.field(src, "path", path, (str,))
    c.field(src, "sha256_16", path, (str,))
    c.field(src, "bytes", path, _INT, non_negative=True)
    c.field(src, "duration_ms", path, _INT, positive=True)
    c.field(src, "fps", path, _NUM, positive=True)
    c.field(src, "vfr", path, (bool,))
    c.field(src, "width", path, _INT, positive=True)
    c.field(src, "height", path, _INT, positive=True)
    c.field(src, "rotation", path, _INT, enum=ROTATIONS)
    c.field(src, "has_audio", path, (bool,))
    c.field(src, "audio_sr", path, _INT, optional=True, positive=True)


def _check_trim(c, trim, path):
    c.field(trim, "file", path, (str,))
    start = c.field(trim, "source_start_ms", path, _INT, non_negative=True)
    end = c.field(trim, "source_end_ms", path, _INT, non_negative=True)
    c.field(trim, "encoded_start_ms", path, _INT, non_negative=True)
    c.field(trim, "width", path, _INT, positive=True)
    c.field(trim, "height", path, _INT, positive=True)
    if start is not None and end is not None and end <= start:
        c.add("%s.source_end_ms" % path,
              "must be > source_start_ms (%d), got %d" % (start, end))


def _check_crop(c, crop, path):
    for name in ("x", "y"):
        c.field(crop, name, path, _INT, non_negative=True)
    for name in ("w", "h"):
        c.field(crop, name, path, _INT, positive=True)
    c.const(crop, "space", path, CROP_SPACE)
    c.field(crop, "static", path, (bool,))


def _check_detection(c, det, path):
    c.field(det, "method", path, (str,))
    c.field(det, "contact_ms", path, _INT, non_negative=True)
    c.field(det, "onset_peak", path, _NUM, optional=True)
    c.field(det, "verified", path, (bool,))
    c.field(det, "reject_reason", path, (str,), optional=True,
            enum=REJECT_REASONS)


def _check_labels(c, labels, path):
    c.field(labels, "player_slot", path, (str,), optional=True,
            enum=PLAYER_SLOTS)
    c.field(labels, "player_name", path, (str,), optional=True)
    c.field(labels, "stroke", path, (str,), optional=True, enum=STROKES)
    c.field(labels, "quality", path, _INT, optional=True, enum=QUALITY)
    c.field(labels, "verdict", path, (str,), optional=True, enum=VERDICTS)
    c.field(labels, "notes", path, (str,), optional=True)
    if "tags" not in labels:
        c.add("%s.tags" % path, "missing")
    elif not isinstance(labels["tags"], list):
        c.add("%s.tags" % path, "expected list, got %s"
              % type(labels["tags"]).__name__)
    else:
        for i, tag in enumerate(labels["tags"]):
            if not isinstance(tag, str):
                c.add("%s.tags[%d]" % (path, i), "expected string")


def _check_frames(c, frames, path):
    if not isinstance(frames, list):
        c.add(path, "expected list, got %s" % type(frames).__name__)
        return
    if not frames:
        c.add(path, "must not be empty")
        return
    prev_ms = None
    for i, frame in enumerate(frames):
        where = "%s[%d]" % (path, i)
        if not isinstance(frame, dict):
            c.add(where, "expected object")
            continue
        c.field(frame, "file", where, (str,))
        ms = c.field(frame, "source_ms", where, _INT, non_negative=True)
        c.field(frame, "clip_ms", where, _INT)
        c.field(frame, "offset_contact_ms", where, _INT)
        # Always optional, even when `measurements` is present. The frame
        # span is deliberately wider than the pose window -- a human needs
        # dense stills either side of contact, but pose is only decoded near
        # it -- so the outer frames have no score to carry. Requiring one
        # here made every default `run` fail validation after writing the
        # clip and all its JPEGs.
        c.field(frame, "pose_score", where, _NUM, optional=True)
        c.field(frame, "stage", where, (str,), optional=True, enum=STAGES)
        # Strictly increasing: overlay() joins on source_ms, so a duplicate
        # would make a human's stage label ambiguous.
        if ms is not None and prev_ms is not None:
            if ms == prev_ms:
                c.add("%s.source_ms" % where, "duplicate value %d" % ms)
            elif ms < prev_ms:
                c.add("%s.source_ms" % where,
                      "must increase: %d after %d" % (ms, prev_ms))
        if ms is not None:
            prev_ms = ms


def _check_measurements(c, m, path):
    c.const(m, "space", path, MEASURE_SPACE)
    c.const(m, "origin", path, MEASURE_ORIGIN)
    c.field(m, "hitting_side", path, (str,), enum=HITTING_SIDES)
    c.field(m, "per_frame", path, (str,), optional=True)
    for name in ("wrist_peak_speed", "torso_height", "contact_offset",
                 "contact_height"):
        c.field(m, name, path, _NUM, optional=True)
    units = c.block(m, "units", path)
    if units is not None:
        for name in ("length", "speed"):
            c.field(units, name, "%s.units" % path, (str,))


def _check_edit(c, edit, path):
    c.field(edit, "by", path, (str,))
    c.field(edit, "at", path, (str,))
    c.field(edit, "against", path, (str,), optional=True)
    c.field(edit, "reviewed", path, (bool,))


def validate_swing(doc):
    """Return a list of error strings; empty means valid.

    Validates both metadata.json and user-edit.json — they are one schema.
    """
    c = _Check()
    if not isinstance(doc, dict):
        return ["<root>: expected object, got %s" % type(doc).__name__]

    c.const(doc, "schema", "<root>", SWING_SCHEMA)
    c.field(doc, "id", "<root>", (str,))

    src = c.block(doc, "source", "<root>")
    if src is not None:
        _check_source(c, src, "source")
    trim = c.block(doc, "trim", "<root>")
    if trim is not None:
        _check_trim(c, trim, "trim")
    crop = c.block(doc, "crop", "<root>")
    if crop is not None:
        _check_crop(c, crop, "crop")
    det = c.block(doc, "detection", "<root>")
    if det is not None:
        _check_detection(c, det, "detection")
    labels = c.block(doc, "labels", "<root>")
    if labels is not None:
        _check_labels(c, labels, "labels")

    # measurements is null when pose was unavailable. Frame pose_score is
    # *not* tied to it: pose is decoded over a narrower window than the frame
    # span, so even a fully measured swing has scoreless frames at the edges.
    if "measurements" not in doc:
        c.add("measurements", "missing")
    elif doc["measurements"] is not None:
        if not isinstance(doc["measurements"], dict):
            c.add("measurements", "expected object or null")
        else:
            _check_measurements(c, doc["measurements"], "measurements")

    if "frames" not in doc:
        c.add("frames", "missing")
    else:
        _check_frames(c, doc["frames"], "frames")

    if "edit" not in doc:
        c.add("edit", "missing (use null in ETL output)")
    elif doc["edit"] is not None:
        if not isinstance(doc["edit"], dict):
            c.add("edit", "expected object or null")
        else:
            _check_edit(c, doc["edit"], "edit")

    return c.errors


def validate_session(doc):
    """Return a list of error strings; empty means valid."""
    c = _Check()
    if not isinstance(doc, dict):
        return ["<root>: expected object, got %s" % type(doc).__name__]

    c.const(doc, "schema", "<root>", SESSION_SCHEMA)

    src = c.block(doc, "source", "<root>")
    if src is not None:
        _check_source(c, src, "source")
    c.block(doc, "settings", "<root>")

    det = c.block(doc, "detection", "<root>")
    if det is not None:
        # `verified` counts what survived verification in the whole video;
        # `rendered` counts what --limit actually wrote. They differ only
        # under --limit, and conflating them made a limited run's document
        # read as though the missing shots had been rejected.
        for name in ("candidates", "verified", "rendered", "rejected"):
            c.field(det, name, "detection", _INT, non_negative=True)
        hist = c.block(det, "reject_histogram", "detection")
        if hist is not None:
            for reason, count in hist.items():
                where = "detection.reject_histogram.%s" % reason
                if reason not in REJECT_REASONS:
                    c.add(where, "unknown reject reason")
                if not _is(count, _INT) or count < 0:
                    c.add(where, "expected non-negative int, got %r" % (count,))

    players = c.block(doc, "players", "<root>")
    if players is not None:
        c.field(players, "mode", "players", (str,), enum=PLAYER_MODES)
        c.field(players, "count", "players", _INT, non_negative=True)
        zones = players.get("zones")
        if not isinstance(zones, list):
            c.add("players.zones", "expected list")
        else:
            for i, zone in enumerate(zones):
                where = "players.zones[%d]" % i
                if not isinstance(zone, dict):
                    c.add(where, "expected object")
                    continue
                c.field(zone, "slot", where, (str,), enum=PLAYER_SLOTS)
                c.field(zone, "swings", where, _INT, non_negative=True)

    swings = doc.get("swings")
    if not isinstance(swings, list):
        c.add("swings", "expected list")
    else:
        for i, ref in enumerate(swings):
            where = "swings[%d]" % i
            if not isinstance(ref, dict):
                c.add(where, "expected object")
                continue
            c.field(ref, "id", where, (str,))
            c.field(ref, "dir", where, (str,))
            c.field(ref, "contact_ms", where, _INT, non_negative=True)
            c.field(ref, "duration_ms", where, _INT, positive=True)
            c.field(ref, "player_slot", where, (str,), optional=True,
                    enum=PLAYER_SLOTS)
            c.field(ref, "frame_count", where, _INT, non_negative=True)
            c.field(ref, "verified", where, (bool,))
            c.field(ref, "reviewed", where, (bool,))

    return c.errors


def new_labels(player_slot=None):
    """An empty triage surface. Everything a human fills starts null."""
    return {"player_slot": player_slot, "player_name": None, "stroke": None,
            "quality": None, "verdict": None, "tags": [], "notes": None}


def new_frame(file, source_ms, clip_ms, offset_contact_ms, pose_score=None):
    return {"file": file, "source_ms": int(source_ms), "clip_ms": int(clip_ms),
            "offset_contact_ms": int(offset_contact_ms),
            "pose_score": pose_score, "stage": None}


def doc_hash(doc):
    """Stable hash of the ETL-owned content of a swing doc.

    Key order independent, and the `edit` block is excluded: `edit.against`
    records which ETL output was reviewed, so including the human's own
    stamp would make it impossible to compare.
    """
    payload = {k: v for k, v in doc.items() if k != "edit"}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _noop(_msg):
    pass


def overlay(metadata, user_edit, warn=_noop, metadata_hash=None):
    """Merge human edits onto ETL output. Returns a new doc; inputs untouched.

    Rules:
      1. No user_edit -> metadata unchanged.
      2. labels: field by field, non-null in user_edit wins (tags: non-empty).
      3. frames: joined on source_ms, never array position. A non-null stage
         wins. Frames whose source_ms is absent from metadata are dropped
         and reported.
      4. source/trim/crop/detection/measurements: metadata always wins.
      5. A mismatched edit.against is reported but still overlaid.

    Joining frames on source_ms rather than index is what makes re-extraction
    at a different fps non-destructive: `frames[8]` silently means a different
    moment after --fps changes, and user-edit.json is written by a separate
    process at a separate time.
    """
    if user_edit is None:
        return metadata

    merged = json.loads(json.dumps(metadata))  # deep copy, JSON-safe by design

    edit_meta = user_edit.get("edit")
    if metadata_hash and isinstance(edit_meta, dict):
        against = edit_meta.get("against")
        if against and against != metadata_hash:
            warn("stale edit: reviewed against %s but metadata is %s"
                 % (against, metadata_hash))

    src_labels = user_edit.get("labels") or {}
    dst_labels = merged.setdefault("labels", new_labels())
    for key, value in src_labels.items():
        if key == "tags":
            if value:
                dst_labels["tags"] = list(value)
        elif value is not None:
            dst_labels[key] = value

    edits_by_ms = {}
    for frame in user_edit.get("frames") or []:
        ms = frame.get("source_ms")
        if ms is not None:
            edits_by_ms[ms] = frame

    known = {f.get("source_ms") for f in merged.get("frames") or []}
    for ms in sorted(set(edits_by_ms) - known):
        warn("dropped edit for unknown frame source_ms=%d "
             "(frame grid changed)" % ms)

    for frame in merged.get("frames") or []:
        edited = edits_by_ms.get(frame.get("source_ms"))
        if edited and edited.get("stage") is not None:
            frame["stage"] = edited["stage"]

    # Rule 4 is implicit: merged started as a copy of metadata and nothing
    # above touches an ETL-owned block. Kept explicit for the reader.
    for block in ETL_OWNED:
        if block in metadata:
            merged[block] = json.loads(json.dumps(metadata[block]))

    if isinstance(edit_meta, dict):
        merged["edit"] = json.loads(json.dumps(edit_meta))

    return merged
