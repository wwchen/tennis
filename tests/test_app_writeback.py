"""The app writes user-edit.json; this checks the ETL can read it back.

Deliberately validated by schema.py rather than by a TypeScript assertion: a
TS mirror of the validator could drift from the real one, and drift between a
validator and its pipeline is exactly the bug class this suite exists to catch.
"""

import json
import os
import shutil
import tempfile
import unittest

from tennisproc import schema, session

FIXTURE = os.path.join(os.path.dirname(__file__), os.pardir,
                       "src", "domain", "__fixtures__", "swing-real.json")


class TestAppWriteback(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        with open(FIXTURE, encoding="utf-8") as fh:
            self.metadata = json.load(fh)

    def _user_edit(self, **labels):
        """The document shape src/domain/etl-write.ts produces."""
        doc = dict(self.metadata)
        doc["labels"] = dict(self.metadata["labels"], **labels)
        doc["edit"] = {"by": "reviewer", "at": "2026-08-16T12:00:00Z",
                       "against": schema.doc_hash(self.metadata),
                       "reviewed": True}
        return doc

    def test_doc_hash_of_the_fixture_is_pinned(self):
        """The vite middleware reimplements this in TypeScript; if either side
        changes its JSON canonicalisation, edit.against silently stops
        matching. Pinning the value makes that a test failure."""
        self.assertEqual(schema.doc_hash(self.metadata),
                         "sha256:6caa72ffd3c91439")

    def test_doc_hash_keeps_an_integral_float_apart_from_an_int(self):
        """The pinned fixture above happens to contain no integral float, so it
        asserts nothing about the one place the two implementations actually
        diverged: json.dumps writes a float with repr(), so 1.0 stays "1.0",
        while JSON.stringify(1.0) is "1". Real output hits this --
        detection.contact_offset is -1.0 in 2 of the sample session's 42 swings
        and measurements.wrist_peak_speed is 40.0 in another -- and the effect
        was a false "stale review" warning on ~10% of reviewed swings. Neither
        field is produced any longer, but this hashes trees on disk and 2505
        shipped swings still carry them.

        The same two constants are pinned in vite-plugin-shot-lab.test.ts, so
        neither side can drift alone."""
        self.assertNotEqual(schema.doc_hash({"a": 1.0}),
                            schema.doc_hash({"a": 1}))
        self.assertEqual(schema.doc_hash({"a": 1.0}),
                         "sha256:c29a44abc114a1d7")
        self.assertEqual(schema.doc_hash({"a": 1}),
                         "sha256:015abd7f5cc57a2d")

    def test_doc_hash_of_a_swing_carrying_an_integral_float_is_pinned(self):
        """A whole swing doc shaped like swing_010, whose contact_offset is
        -1.0. This is the document class the TypeScript hash got wrong, and it
        still has to validate -- both fields are _NUM, so an integral float is
        legal output, not a malformed doc."""
        doc = json.loads(json.dumps(self.metadata))
        doc["measurements"]["contact_offset"] = -1.0
        doc["measurements"]["wrist_peak_speed"] = 40.0
        self.assertEqual(schema.validate_swing(doc), [])
        self.assertEqual(schema.doc_hash(doc), "sha256:501eafc9a1f2f70d")

    def test_app_written_document_is_valid(self):
        doc = self._user_edit(stroke="backhand", quality=4, verdict="valid",
                              notes="late contact")
        self.assertEqual(schema.validate_swing(doc), [])

    def test_overlay_surfaces_the_humans_labels(self):
        edit = self._user_edit(stroke="backhand", quality=4, verdict="valid")
        merged = schema.overlay(self.metadata, edit)
        self.assertEqual(merged["labels"]["stroke"], "backhand")
        self.assertEqual(merged["labels"]["quality"], 4)
        # ETL-owned facts survive a stale or hostile edit.
        self.assertEqual(merged["detection"], self.metadata["detection"])
        self.assertEqual(merged["trim"], self.metadata["trim"])

    def test_stage_lands_on_the_same_moment_by_source_ms(self):
        contact_ms = self.metadata["detection"]["contact_ms"]
        edit = self._user_edit()
        edit["frames"] = [{"file": "frames/frame_0024.jpg",
                           "source_ms": contact_ms, "clip_ms": 0,
                           "offset_contact_ms": 0, "pose_score": None,
                           "stage": "contact"}]
        merged = schema.overlay(self.metadata, edit)
        tagged = [f for f in merged["frames"] if f["stage"] == "contact"]
        self.assertEqual(len(tagged), 1)
        self.assertEqual(tagged[0]["source_ms"], contact_ms)

    def test_a_swing_dir_with_an_edit_reads_as_reviewed(self):
        swing = os.path.join(self.tmp, "swing_001")
        os.makedirs(swing)
        session.write_json(os.path.join(swing, "metadata.json"), self.metadata)
        session.write_json(os.path.join(swing, "user-edit.json"),
                           self._user_edit(stroke="serve"))
        merged, _ = session.load_swing(swing)
        self.assertEqual(merged["labels"]["stroke"], "serve")


class TestPreservedLabelsRoundTrip(unittest.TestCase):
    """The app's write projection used to collapse verdict onto a boolean and
    quality onto 2/3/4, so a bare page load rewrote a reviewer's own file with
    coarser labels -- and a non-null value wins in overlay(), so the loss was
    permanent. src/domain/etl-write.ts now carries the source value through
    whenever the reviewer has not changed it, which means user-edit.json can
    legally contain any VERDICTS member and any QUALITY value, not just the
    handful the old projection could emit.

    These check the ETL side of that contract: the preserved values still
    validate, and overlay() lands them where the app expects.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        with open(FIXTURE, encoding="utf-8") as fh:
            self.metadata = json.load(fh)

    def _write(self, user_edit):
        """A swing dir the app has written an edit into. Returns load_swing()."""
        swing = os.path.join(self.tmp, "swing_001")
        os.makedirs(swing, exist_ok=True)
        session.write_json(os.path.join(swing, "metadata.json"), self.metadata)
        session.write_json(os.path.join(swing, "user-edit.json"), user_edit)
        # load_swing returns (merged, warnings).
        return session.load_swing(swing)

    def _preserving_edit(self, **labels):
        doc = json.loads(json.dumps(self.metadata))
        doc["labels"] = dict(self.metadata["labels"], **labels)
        doc["edit"] = {"by": "reviewer", "at": "2026-08-16T12:00:00Z",
                       "against": schema.doc_hash(self.metadata),
                       "reviewed": True}
        return doc

    def test_every_verdict_the_app_can_now_preserve_is_valid(self):
        # Asserted explicitly rather than derived from VERDICTS: iterating the
        # constant under test means shrinking the vocabulary back to the old
        # lossy set still passes. `duplicate` is the member the old projection
        # could not emit, and the one whose loss re-hid a clip on every load.
        self.assertIn("duplicate", schema.VERDICTS)
        self.assertIn("unclear", schema.VERDICTS)
        for verdict in schema.VERDICTS:
            with self.subTest(verdict=verdict):
                doc = self._preserving_edit(verdict=verdict)
                self.assertEqual(schema.validate_swing(doc), [])
                merged, warnings = self._write(doc)
                self.assertEqual(warnings, [])
                self.assertEqual(merged["labels"]["verdict"], verdict)

    def test_every_quality_the_app_can_now_preserve_is_valid(self):
        # 1 and 5 were unreachable through the old projection; an untouched
        # rating now writes back whatever it was. Pinned explicitly for the same
        # reason as the verdicts above -- these two are the values the old
        # projection collapsed, so the test has to name them.
        self.assertIn(1, schema.QUALITY)
        self.assertIn(5, schema.QUALITY)
        for quality in schema.QUALITY:
            with self.subTest(quality=quality):
                doc = self._preserving_edit(quality=quality)
                self.assertEqual(schema.validate_swing(doc), [])
                merged, warnings = self._write(doc)
                self.assertEqual(warnings, [])
                self.assertEqual(merged["labels"]["quality"], quality)

    def test_a_null_verdict_the_reviewer_left_alone_stays_null(self):
        """The worst of the old collapses. `null -> valid` could not be undone
        by re-reading, because a non-null value in the edit wins."""
        self.assertIsNone(self.metadata["labels"]["verdict"])
        doc = self._preserving_edit(stroke="backhand")
        self.assertIsNone(doc["labels"]["verdict"])
        self.assertEqual(schema.validate_swing(doc), [])
        merged, warnings = self._write(doc)
        self.assertEqual(warnings, [])
        self.assertIsNone(merged["labels"]["verdict"])
        # The label the reviewer did set still lands.
        self.assertEqual(merged["labels"]["stroke"], "backhand")

    def test_a_null_player_name_does_not_erase_the_slot(self):
        """The app writes player_name=None for a swing nobody has named, rather
        than echoing the court slot back as a person's name."""
        doc = self._preserving_edit(player_name=None)
        merged, _ = self._write(doc)
        self.assertIsNone(merged["labels"]["player_name"])
        self.assertEqual(merged["labels"]["player_slot"],
                         self.metadata["labels"]["player_slot"])

    def test_a_stage_far_outside_the_old_nine_frame_window_survives(self):
        """The app carried only 9 of the 49 frames, so a stage on frame 2 or 46
        was dropped on write-back. It now writes the whole list."""
        doc = self._preserving_edit()
        frames = json.loads(json.dumps(self.metadata["frames"]))
        self.assertEqual(len(frames), 49)
        frames[2]["stage"] = "setup"
        frames[46]["stage"] = "finish"
        doc["frames"] = frames
        self.assertEqual(schema.validate_swing(doc), [])

        merged, warnings = self._write(doc)
        self.assertEqual(warnings, [])
        self.assertEqual(len(merged["frames"]), 49)
        tagged = {f["source_ms"]: f["stage"]
                  for f in merged["frames"] if f["stage"] is not None}
        self.assertEqual(tagged, {frames[2]["source_ms"]: "setup",
                                  frames[46]["source_ms"]: "finish"})

    def test_a_preserved_stage_of_other_is_valid_and_lands(self):
        """`other` folds onto no phase in the app, so it has to be written back
        from the source rather than from the folded value."""
        doc = self._preserving_edit()
        frames = json.loads(json.dumps(self.metadata["frames"]))
        frames[3]["stage"] = "other"
        doc["frames"] = frames
        self.assertEqual(schema.validate_swing(doc), [])
        merged, _ = self._write(doc)
        self.assertEqual(merged["frames"][3]["stage"], "other")

    def _lossy_projection(self, merged):
        """What the OLD write projection produced from a merged document.

        Reimplemented here on purpose. The point is not to mirror the current
        TypeScript -- that would just be a second copy to drift -- but to pin
        the DEGRADED document the old code emitted, so the assertions below can
        show the two are different and that only one of them survives overlay().

        The four collapses, from the followups doc's own table:
          quality 1-5     -> 2/3/4 via the three-value grade
          verdict         -> false_positive if rejected else valid
          player_name     -> the court slot, echoed back as a person's name
          frames          -> only the 9 the compare window showed
        """
        labels = merged["labels"]
        quality = labels["quality"]
        if quality is None:
            grade_quality = None
        elif quality <= 2:
            grade_quality = 2          # 1 and 2 both read as "work"
        elif quality == 3:
            grade_quality = 3
        else:
            grade_quality = 4          # 4 and 5 both read as "good"

        rejected = (not merged["detection"]["verified"]
                    or labels["verdict"] in ("false_positive", "duplicate"))

        frames = json.loads(json.dumps(merged["frames"]))
        contact_i = next(i for i, f in enumerate(frames)
                         if f["offset_contact_ms"] == 0)
        start = max(0, min(contact_i - 4, len(frames) - 9))

        doc = json.loads(json.dumps(merged))
        doc["labels"] = dict(labels,
                             quality=grade_quality,
                             verdict="false_positive" if rejected else "valid",
                             player_name=labels["player_name"]
                             or labels["player_slot"] or "unassigned")
        doc["frames"] = frames[start:start + 9]
        doc["edit"] = {"by": "reviewer", "at": "2026-08-16T18:30:00Z",
                       "against": schema.doc_hash(self.metadata),
                       "reviewed": True}
        return doc

    def test_the_old_projection_degrades_what_the_preserved_one_keeps(self):
        """The cross-language check with teeth.

        The previous version of this test fed a document to itself and compared
        doc_hash, which EXCLUDES `edit` -- so the equality held for any input at
        all, including a fully degraded one, and its label assertions only read
        back values it had hardcoded twenty lines earlier.

        This asserts the falsifiable thing instead: the document the old lossy
        projection would have produced is DIFFERENT from the preserved one, and
        only the preserved one survives overlay() with the human's labels
        intact. If the projection ever regresses to the old behaviour, the
        preserved document starts matching the lossy one and this fails.
        """
        preserved = self._preserving_edit(quality=5, verdict="duplicate",
                                          player_name=None, stroke="backhand",
                                          notes="shanked, keep for the reel")
        frames = json.loads(json.dumps(self.metadata["frames"]))
        frames[2]["stage"] = "setup"
        frames[46]["stage"] = "finish"
        preserved["frames"] = frames

        merged, warnings = self._write(preserved)
        self.assertEqual(warnings, [])

        lossy = self._lossy_projection(merged)

        # 1. The two projections genuinely disagree -- on every field the
        #    followups table names, so this cannot pass by accident.
        self.assertNotEqual(schema.doc_hash(lossy), schema.doc_hash(preserved))
        self.assertNotEqual(lossy["labels"]["quality"],
                            preserved["labels"]["quality"])
        self.assertNotEqual(lossy["labels"]["verdict"],
                            preserved["labels"]["verdict"])
        self.assertNotEqual(lossy["labels"]["player_name"],
                            preserved["labels"]["player_name"])
        self.assertNotEqual(len(lossy["frames"]), len(preserved["frames"]))

        # 2. The lossy document is what actually destroys the human's work:
        #    a non-null value wins in overlay(), so re-reading cannot undo it.
        after_lossy, _ = self._write(lossy)
        self.assertEqual(after_lossy["labels"]["quality"], 4)
        self.assertEqual(after_lossy["labels"]["verdict"], "false_positive")
        self.assertEqual(after_lossy["labels"]["player_name"], "left")
        # The two far stage tags are gone -- they were outside the 9-frame slice.
        surviving = {f["source_ms"]: f["stage"]
                     for f in after_lossy["frames"] if f["stage"] is not None}
        self.assertEqual(surviving, {})

        # 3. The preserved document survives the same round trip intact.
        again, warnings = self._write(preserved)
        self.assertEqual(warnings, [])
        self.assertEqual(again["labels"]["quality"], 5)
        self.assertEqual(again["labels"]["verdict"], "duplicate")
        self.assertIsNone(again["labels"]["player_name"])
        self.assertEqual(again["labels"]["player_slot"], "left")
        self.assertEqual(len(again["frames"]), 49)
        self.assertEqual(
            {f["source_ms"]: f["stage"]
             for f in again["frames"] if f["stage"] is not None},
            {frames[2]["source_ms"]: "setup",
             frames[46]["source_ms"]: "finish"})

    def test_a_stage_on_a_source_ms_metadata_lost_stays_on_disk(self):
        """overlay() drops a frame whose source_ms metadata does not know and
        WARNS, rather than failing -- deliberately, so re-extracting back at the
        original --fps recovers the tag. That only holds if the app stops
        deleting those entries from user-edit.json, which it did on any bare
        page load: its projection is built from the MERGED document, where the
        orphan is already gone.

        This is the ETL half of the contract src/domain/etl-write.ts's
        `orphanedFrames` upholds.
        """
        orphan_ms = self.metadata["frames"][24]["source_ms"] + 16
        self.assertNotIn(orphan_ms,
                         [f["source_ms"] for f in self.metadata["frames"]])

        doc = self._preserving_edit()
        frames = json.loads(json.dumps(self.metadata["frames"]))
        # Inserted in source_ms order, not appended: schema.py:206 requires the
        # list to be strictly increasing, which is exactly why the app's
        # write-back sorts after re-attaching an orphan rather than pushing it
        # onto the end.
        frames.append({"file": "frames/frame_0099.jpg",
                       "source_ms": orphan_ms, "clip_ms": 816,
                       "offset_contact_ms": 16, "pose_score": None,
                       "stage": "contact"})
        frames.sort(key=lambda f: f["source_ms"])
        doc["frames"] = frames
        self.assertEqual(schema.validate_swing(doc), [])

        merged, warnings = self._write(doc)
        # Dropped from the merged view, and reported -- not silently ignored.
        self.assertEqual(len(merged["frames"]), 49)
        self.assertEqual(len(warnings), 1)
        self.assertIn("source_ms=%d" % orphan_ms, warnings[0])

        # Still on disk, which is what makes it recoverable.
        with open(os.path.join(self.tmp, "swing_001", "user-edit.json"),
                  encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertEqual(
            [f["stage"] for f in on_disk["frames"]
             if f["source_ms"] == orphan_ms],
            ["contact"])


class TestSanitisedLabels(unittest.TestCase):
    """The app must never write a document schema.py rejects.

    `overlay()` lifts `labels` out of user-edit.json field by field with NO
    validation (schema.py:424), and src/domain/etl-write.ts spreads
    `...source.labels` -- so anything the projection does not compute is echoed
    straight back, whatever it is. A hand-edited or foreign user-edit.json could
    therefore make toUserEdit emit a document validate_swing rejects: the app
    writing a file its own pipeline cannot read.

    This is the half that matters, because schema.py is the real judge. A
    TypeScript assertion about what "valid" means could drift from the validator;
    these documents are run through the validator itself.

    `_sanitise` mirrors what src/domain/etl-write.ts's `sanitiseLabels` does. The
    pairing is the point: for each malformed input, the UNSANITISED document is
    asserted INVALID and the sanitised one VALID. If the TS side ever stops
    sanitising, the app starts emitting the documents proven invalid here.
    """

    def setUp(self):
        with open(FIXTURE, encoding="utf-8") as fh:
            self.metadata = json.load(fh)
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)

    def _doc(self, **labels):
        """A user-edit.json carrying `labels`, as the app would spread them."""
        doc = json.loads(json.dumps(self.metadata))
        doc["labels"] = dict(doc["labels"], **labels)
        doc["edit"] = {"by": "reviewer", "at": "2026-08-16T12:00:00Z",
                       "against": schema.doc_hash(self.metadata),
                       "reviewed": True}
        return doc

    @staticmethod
    def _sanitise(doc):
        """`sanitiseLabels` from src/domain/etl-write.ts, in Python.

        Deliberately a reimplementation rather than a call across the language
        boundary: there is no runtime that can invoke the TypeScript here, and the
        assertions below are about what the VALIDATOR accepts, so a faithful
        restatement of the rule is enough to demonstrate that a document sanitised
        by that rule passes where the raw one fails.
        """
        out = json.loads(json.dumps(doc))
        labels = out["labels"]

        def member(value, vocab):
            # bool is a subclass of int, so `True in (1, ...)` is True. schema.py's
            # `_is` refuses a bool for an integer field, so the TS `isMember`
            # check over QUALITY has to refuse it too -- and it does, because
            # JS has no bool/number conflation. Restated explicitly here.
            if isinstance(value, bool):
                return False
            return value in vocab

        def text(value):
            return value if isinstance(value, str) else None

        labels["player_slot"] = (labels.get("player_slot")
                                 if member(labels.get("player_slot"),
                                           schema.PLAYER_SLOTS) else None)
        labels["player_name"] = text(labels.get("player_name"))
        labels["stroke"] = (labels.get("stroke")
                            if member(labels.get("stroke"), schema.STROKES)
                            else None)
        labels["quality"] = (labels.get("quality")
                             if member(labels.get("quality"), schema.QUALITY)
                             else None)
        labels["verdict"] = (labels.get("verdict")
                             if member(labels.get("verdict"), schema.VERDICTS)
                             else None)
        labels["notes"] = text(labels.get("notes"))
        tags = labels.get("tags")
        labels["tags"] = ([t for t in tags if isinstance(t, str)]
                          if isinstance(tags, list) else [])
        return out

    def _assert_repaired(self, raw, *, expect_error_at):
        """The raw doc is rejected, the sanitised one accepted."""
        errors = schema.validate_swing(raw)
        self.assertTrue(any(e.startswith(expect_error_at) for e in errors),
                        "expected an error at %s, got %r"
                        % (expect_error_at, errors))
        self.assertEqual(schema.validate_swing(self._sanitise(raw)), [])

    # --- tags: the recorded follow-up (I3) ---

    def test_a_non_string_tag_is_rejected_and_dropping_it_is_accepted(self):
        """schema.py:178. The exact case from the follow-ups doc."""
        raw = self._doc(tags=[1, None])
        errors = schema.validate_swing(raw)
        self.assertIn("labels.tags[0]: expected string", errors)
        self.assertIn("labels.tags[1]: expected string", errors)

        clean = self._sanitise(raw)
        self.assertEqual(schema.validate_swing(clean), [])
        # Dropped, not coerced. `String(1)` would invent the tag "1", and a
        # non-empty list WINS in overlay() -- so a fabricated label would then be
        # unremovable by re-reading, which is the §1 failure mode all over again.
        self.assertEqual(clean["labels"]["tags"], [])

    def test_the_valid_tags_around_a_bad_one_survive(self):
        raw = self._doc(tags=["reel", 1, None, "drill", True])
        self.assertNotEqual(schema.validate_swing(raw), [])
        clean = self._sanitise(raw)
        self.assertEqual(schema.validate_swing(clean), [])
        self.assertEqual(clean["labels"]["tags"], ["reel", "drill"])

    def test_a_string_tags_is_rejected_and_an_empty_list_is_accepted(self):
        """schema.py:172 requires a list. `tags: "backhand"` is the other half
        of I3 -- and note a str is iterable, so a validator that only checked
        members would have accepted it one character at a time."""
        raw = self._doc(tags="backhand")
        self._assert_repaired(raw, expect_error_at="labels.tags: expected list")
        self.assertEqual(self._sanitise(raw)["labels"]["tags"], [])

    def test_an_absent_tags_is_rejected_and_an_empty_list_is_accepted(self):
        raw = self._doc()
        del raw["labels"]["tags"]
        self._assert_repaired(raw, expect_error_at="labels.tags: missing")

    def test_an_empty_tags_cannot_erase_a_list_metadata_carries(self):
        """`[]` is the value the app writes for "no tags", and it is also the one
        value overlay() treats as no opinion (`if value:`) -- so sanitising a
        malformed list to `[]` cannot destroy tags the ETL itself wrote."""
        metadata = json.loads(json.dumps(self.metadata))
        metadata["labels"]["tags"] = ["etl-tag"]
        edit = self._doc(tags=[])
        merged = schema.overlay(metadata, edit)
        self.assertEqual(merged["labels"]["tags"], ["etl-tag"])

    # --- the other fields the same spread exposes ---

    def test_a_stroke_outside_the_enum_is_rejected_and_null_is_accepted(self):
        # 'slice' is the interesting one: it is deliberately NOT in STROKES (spin
        # is not recoverable at 30 fps), and it survives the app's read path
        # invisibly -- strokeToApp gives 'Slice', which compares equal to itself,
        # so the illegal value used to be written straight back out.
        self.assertNotIn("slice", schema.STROKES)
        self._assert_repaired(self._doc(stroke="slice"),
                             expect_error_at="labels.stroke")
        self._assert_repaired(self._doc(stroke="Backhand"),
                             expect_error_at="labels.stroke")

    def test_a_verdict_outside_the_enum_is_rejected_and_null_is_accepted(self):
        self._assert_repaired(self._doc(verdict="nope"),
                             expect_error_at="labels.verdict")

    def test_a_quality_outside_1_to_5_is_rejected_and_null_is_accepted(self):
        self._assert_repaired(self._doc(quality=9),
                             expect_error_at="labels.quality")
        self._assert_repaired(self._doc(quality=0),
                             expect_error_at="labels.quality")

    def test_a_float_quality_is_rejected_because_quality_is_an_int(self):
        """3.5 is not an int, so _INT refuses it before the enum check."""
        self._assert_repaired(self._doc(quality=3.5),
                             expect_error_at="labels.quality")

    def test_a_bool_quality_is_rejected_because_bool_must_not_pass_as_int(self):
        """schema.py's `_is` refuses a bool for an integer field on purpose --
        `True in QUALITY` is True in Python, since bool subclasses int. The app
        must not echo one, and `isMember(ETL_QUALITY, true)` in TypeScript is
        false because JS has no such conflation."""
        self._assert_repaired(self._doc(quality=True),
                             expect_error_at="labels.quality")

    def test_a_player_slot_outside_the_enum_is_rejected(self):
        self._assert_repaired(self._doc(player_slot="middle"),
                             expect_error_at="labels.player_slot")

    def test_a_non_string_player_name_and_notes_are_rejected(self):
        self._assert_repaired(self._doc(player_name=12),
                             expect_error_at="labels.player_name")
        self._assert_repaired(self._doc(notes=["a", "b"]),
                             expect_error_at="labels.notes")

    def test_a_stage_outside_the_enum_is_rejected(self):
        """schema.py:207. Reached because stageToPhase only folds `null` and
        `other`, so 'wobble' arrives at the clip AS a phase, compares equal to
        itself, and used to be written back."""
        raw = self._doc()
        raw["frames"] = json.loads(json.dumps(self.metadata["frames"]))
        raw["frames"][3]["stage"] = "wobble"
        errors = schema.validate_swing(raw)
        self.assertTrue(any(e.startswith("frames[3].stage") for e in errors),
                        errors)
        raw["frames"][3]["stage"] = None
        self.assertEqual(schema.validate_swing(raw), [])

    def test_every_field_malformed_at_once_still_repairs_to_a_valid_document(self):
        raw = self._doc(tags=["reel", 1], stroke="slice", quality=9,
                        verdict="nope", player_slot="middle", player_name=12,
                        notes=["a"])
        # Every one of them is a real error, so this is not passing by accident.
        # Seven, not eight: `tags[0]` is "reel", a perfectly good tag, and only
        # `tags[1]` is reported. That asymmetry is exactly why sanitising filters
        # the list rather than discarding it.
        self.assertEqual(sorted(schema.validate_swing(raw)), sorted([
            "labels.player_slot: 'middle' not one of "
            "['left', 'right', 'near', 'far']",
            "labels.player_name: expected str, got int",
            "labels.stroke: 'slice' not one of ['forehand', 'backhand', "
            "'volley', 'serve', 'overhead', 'other']",
            "labels.quality: 9 not one of [1, 2, 3, 4, 5]",
            "labels.verdict: 'nope' not one of ['valid', 'false_positive', "
            "'duplicate', 'unclear']",
            "labels.notes: expected str, got list",
            "labels.tags[1]: expected string",
        ]))

        clean = self._sanitise(raw)
        self.assertEqual(schema.validate_swing(clean), [])
        self.assertEqual(clean["labels"],
                         {"player_slot": None, "player_name": None,
                          "stroke": None, "quality": None, "verdict": None,
                          "tags": ["reel"], "notes": None})

    def test_the_repaired_document_round_trips_through_load_swing(self):
        """End to end on the ETL side: the sanitised document is not just valid,
        it is readable -- `load_swing` overlays it without warning."""
        swing = os.path.join(self.tmp, "swing_001")
        os.makedirs(swing, exist_ok=True)
        session.write_json(os.path.join(swing, "metadata.json"), self.metadata)
        clean = self._sanitise(self._doc(tags=["reel", 1], quality=9))
        session.write_json(os.path.join(swing, "user-edit.json"), clean)
        # load_swing returns (merged, warnings).
        merged, warnings = session.load_swing(swing)
        self.assertEqual(warnings, [])
        self.assertEqual(schema.validate_swing(merged), [])
        self.assertEqual(merged["labels"]["tags"], ["reel"])
        self.assertIsNone(merged["labels"]["quality"])

    def test_validate_tree_reports_only_the_unsanitised_edit(self):
        """The check a reviewer actually runs, over a whole tree.

        `validate_tree` walks both metadata.json and user-edit.json in every swing
        dir and also checks that referenced media EXISTS, so this builds a tree
        complete enough that the only thing it can complain about is the edit
        itself -- otherwise "problems is non-empty" would prove nothing.
        """
        root = os.path.join(self.tmp, "IMG_0304")
        swing = os.path.join(root, "swings", "swing_001")
        os.makedirs(swing, exist_ok=True)
        session.write_json(os.path.join(root, "metadata.json"),
                           _session_doc(self.metadata))
        session.write_json(os.path.join(swing, "metadata.json"), self.metadata)
        _touch_media(swing, self.metadata)

        # The tree is clean before the edit lands, so the assertions below are
        # about the edit and nothing else.
        _, problems = session.validate_tree(root)
        self.assertEqual(problems, [])

        raw = self._doc(tags=[1, None])
        session.write_json(os.path.join(swing, "user-edit.json"), raw)
        _, problems = session.validate_tree(root)
        self.assertEqual(len(problems), 1)
        path, errors = problems[0]
        self.assertTrue(path.endswith("user-edit.json"), path)
        self.assertEqual(sorted(errors), ["labels.tags[0]: expected string",
                                         "labels.tags[1]: expected string"])

        session.write_json(os.path.join(swing, "user-edit.json"),
                           self._sanitise(raw))
        _, problems = session.validate_tree(root)
        self.assertEqual(problems, [])


def _touch_media(swing_dir, metadata):
    """Create the frame stills and clip file a swing's documents reference.

    `validate_tree` reports a frame whose file is missing, so a tree without them
    is never clean and could not show that sanitising is what fixed it.
    """
    for frame in metadata["frames"]:
        path = os.path.join(swing_dir, frame["file"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(b"")
    with open(os.path.join(swing_dir, metadata["trim"]["file"]), "wb") as fh:
        fh.write(b"")


def _session_doc(swing_metadata):
    """A session metadata.json `validate_session` accepts, around one swing.

    Every block is filled: `validate_session` requires counts in `detection` and
    a `players` block with a mode, a count and a zone list, so an empty dict for
    either makes the whole tree report problems for reasons unrelated to the edit
    under test.
    """
    trim = swing_metadata["trim"]
    return {
        "schema": schema.SESSION_SCHEMA,
        "source": swing_metadata["source"],
        "settings": {},
        # `rendered` is separate from `verified` — it counts what --limit
        # actually wrote. This tree has the one swing, verified and written.
        "detection": {"candidates": 1, "verified": 1, "rendered": 1,
                      "rejected": 0, "reject_histogram": {}},
        "players": {"mode": "side", "count": 1,
                    "zones": [{"slot": swing_metadata["labels"]["player_slot"],
                               "swings": 1}]},
        "swings": [{
            "id": swing_metadata["id"],
            "dir": "swings/swing_001",
            "contact_ms": swing_metadata["detection"]["contact_ms"],
            "duration_ms": trim["source_end_ms"] - trim["source_start_ms"],
            "player_slot": swing_metadata["labels"]["player_slot"],
            "frame_count": len(swing_metadata["frames"]),
            "verified": swing_metadata["detection"]["verified"],
            "reviewed": True,
        }],
    }


class TestPreservedAttribution(unittest.TestCase):
    """`edit.by` and `edit.against`, from the ETL side (follow-up I4).

    `against` records WHICH ETL OUTPUT was reviewed. It exists so overlay() can
    warn "stale edit: reviewed against X but metadata is Y" (schema.py:419) --
    that is how a reviewer learns the underlying clip was re-rendered since they
    looked at it. The app used to overwrite it with the CURRENT hash on every
    load-time write-back, with no user action, which erases exactly that signal.

    These pin the ETL behaviour the app's preservation exists to keep working.
    """

    def setUp(self):
        with open(FIXTURE, encoding="utf-8") as fh:
            self.metadata = json.load(fh)
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)

    def _load(self, user_edit):
        swing = os.path.join(self.tmp, "swing_001")
        os.makedirs(swing, exist_ok=True)
        session.write_json(os.path.join(swing, "metadata.json"), self.metadata)
        session.write_json(os.path.join(swing, "user-edit.json"), user_edit)
        # load_swing returns (merged, warnings).
        return session.load_swing(swing)

    def _edit(self, **edit):
        doc = json.loads(json.dumps(self.metadata))
        doc["labels"] = dict(doc["labels"], stroke="backhand", quality=5)
        doc["edit"] = dict({"by": "coach-ana", "at": "2026-08-10T09:00:00Z",
                            "against": "sha256:0000000000000000",
                            "reviewed": True}, **edit)
        return doc

    def test_a_preserved_stale_against_still_warns(self):
        """The signal the app must not destroy. If write-back rewrites `against`
        to the current hash, this warning stops firing and a stale review
        silently claims to be current."""
        stale = self._edit()
        self.assertNotEqual(stale["edit"]["against"],
                            schema.doc_hash(self.metadata))
        self.assertEqual(schema.validate_swing(stale), [])

        merged, warnings = self._load(stale)
        self.assertEqual(len(warnings), 1)
        self.assertIn("stale edit", warnings[0])
        self.assertIn("sha256:0000000000000000", warnings[0])
        # Reported, but still overlaid -- rule 5. The human's work is not
        # discarded just because the clip was re-rendered.
        self.assertEqual(merged["labels"]["stroke"], "backhand")
        self.assertEqual(merged["labels"]["quality"], 5)

    def test_rewriting_against_to_the_current_hash_silences_the_warning(self):
        """The bug, demonstrated: the ONLY difference between this document and
        the one above is `against`, and it is the difference between a reviewer
        being told the clip was re-rendered and never finding out."""
        laundered = self._edit(against=schema.doc_hash(self.metadata))
        _, warnings = self._load(laundered)
        self.assertEqual(warnings, [])

    def test_a_preserved_foreign_by_is_valid_and_survives_the_overlay(self):
        """`by` is any string, so preserving "coach-ana" is legal output -- the
        app is not choosing between attribution and validity."""
        foreign = self._edit(by="coach-ana")
        self.assertEqual(schema.validate_swing(foreign), [])
        merged, _ = self._load(foreign)
        self.assertEqual(merged["edit"]["by"], "coach-ana")

    def test_an_absent_against_is_missing_but_null_is_legal(self):
        """The trap `optional=True` sets, and the reason the app writes an
        explicit null rather than omitting the key.

        `optional=True` reads as "this field may be absent", but that is NOT what
        `_Check.field` does: it reports `missing` and RETURNS before it ever
        consults `optional`, which governs only whether a null is accepted. So an
        absent `against` is an error while `against: None` is fine -- the opposite
        way round from the obvious reading, and the app had it backwards.

        A previous file with no `against` therefore must not make write-back omit
        the key. It writes null, which records "nothing to compare against"
        without claiming the review was made against the current render."""
        no_against = self._edit()
        del no_against["edit"]["against"]
        self.assertEqual(schema.validate_swing(no_against),
                         ["edit.against: missing"])

        null_against = self._edit(against=None)
        self.assertEqual(schema.validate_swing(null_against), [])
        merged, warnings = self._load(null_against)
        # Nothing to compare, so nothing to warn about -- and nothing claimed.
        self.assertEqual(warnings, [])
        self.assertIsNone(merged["edit"]["against"])
        # And a null can never be mistaken for "reviewed against what is on disk
        # now", which is the whole reason not to substitute the current hash.
        self.assertNotEqual(null_against["edit"]["against"],
                            schema.doc_hash(self.metadata))

    def test_a_non_string_by_is_rejected_so_it_must_not_be_echoed(self):
        """The one case where preserving `by` verbatim would be wrong: a
        hand-edited file is not a reason to write one the ETL cannot read."""
        junk = self._edit(by=42)
        self.assertIn("edit.by: expected str, got int",
                      schema.validate_swing(junk))

    def test_doc_hash_ignores_edit_so_preserving_it_cannot_change_the_hash(self):
        """Why preserving `by`/`against` is safe: doc_hash EXCLUDES `edit`, so
        carrying a foreign block through cannot make the next comparison think
        the ETL output changed."""
        preserved = self._edit()
        rewritten = self._edit(by="reviewer",
                               against=schema.doc_hash(self.metadata))
        self.assertNotEqual(preserved["edit"], rewritten["edit"])
        self.assertEqual(schema.doc_hash(preserved), schema.doc_hash(rewritten))
