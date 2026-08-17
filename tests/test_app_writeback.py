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
