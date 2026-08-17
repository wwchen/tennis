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
        was a false "stale review" warning on ~10% of reviewed swings.

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
        for verdict in schema.VERDICTS:
            with self.subTest(verdict=verdict):
                doc = self._preserving_edit(verdict=verdict)
                self.assertEqual(schema.validate_swing(doc), [])
                merged, warnings = self._write(doc)
                self.assertEqual(warnings, [])
                self.assertEqual(merged["labels"]["verdict"], verdict)

    def test_every_quality_the_app_can_now_preserve_is_valid(self):
        # 1 and 5 were unreachable through the old projection; an untouched
        # rating now writes back whatever it was.
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

    def test_the_load_only_write_is_a_fixed_point_for_the_etl_too(self):
        """The property the whole follow-up exists to establish, checked from
        the ETL's side: re-reading a swing whose user-edit.json the app rewrote
        without any human action gives back the same merged document."""
        doc = self._preserving_edit(quality=5, verdict="duplicate",
                                    player_name=None, stroke="backhand",
                                    notes="shanked, keep for the reel")
        frames = json.loads(json.dumps(self.metadata["frames"]))
        frames[2]["stage"] = "setup"
        frames[46]["stage"] = "finish"
        doc["frames"] = frames

        first, warnings = self._write(doc)
        self.assertEqual(warnings, [])

        # The app's load-only write differs only in edit.at. Feed that back in.
        second_edit = json.loads(json.dumps(doc))
        second_edit["edit"]["at"] = "2026-08-16T18:30:00Z"
        second, warnings = self._write(second_edit)
        self.assertEqual(warnings, [])

        self.assertEqual(schema.doc_hash(first), schema.doc_hash(second))
        self.assertEqual({k: v for k, v in first.items() if k != "edit"},
                         {k: v for k, v in second.items() if k != "edit"})
        # Nothing degraded across the pass.
        self.assertEqual(first["labels"]["quality"], 5)
        self.assertEqual(first["labels"]["verdict"], "duplicate")
        self.assertIsNone(first["labels"]["player_name"])
        self.assertEqual(len(first["frames"]), 49)
