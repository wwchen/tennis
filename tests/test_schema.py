"""Tests for the SwingDoc/SessionDoc DTOs, the validator, and overlay()."""

import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tennisproc import schema


def make_swing(stage_at=None, n_frames=3, base_ms=106834, step_ms=33):
    """A minimal valid SwingDoc as the ETL would write it.

    stage_at: source_ms of the frame to mark "contact", or None for all-null.

    Default grid is 106834/106867/106900 so that 106900 — the contact time
    used throughout these tests — is actually on it.
    """
    frames = []
    for i in range(n_frames):
        ms = int(round(base_ms + i * step_ms))
        frames.append({
            "file": "frames/frame_%04d.jpg" % i,
            "source_ms": ms,
            "clip_ms": ms - 105400,
            "offset_contact_ms": ms - 106900,
            "pose_score": 0.9,
            "stage": "contact" if ms == stage_at else None,
        })
    return {
        "schema": schema.SWING_SCHEMA,
        "id": "IMG_0305/swing_001",
        "source": {
            "name": "IMG_0305.MOV", "path": "~/Downloads/IMG_0305.MOV",
            "sha256_16": "1f3a9c2b7e4d0a15", "bytes": 1048576000,
            "duration_ms": 318875, "fps": 30.0, "vfr": False,
            "width": 1080, "height": 1920, "rotation": 90,
            "has_audio": True, "audio_sr": 44100,
        },
        "trim": {"file": "clip.mp4", "source_start_ms": 105400,
                 "source_end_ms": 108900, "encoded_start_ms": 105400,
                 "width": 288, "height": 480},
        "crop": {"x": 412, "y": 300, "w": 520, "h": 900,
                 "space": "source_display", "static": True},
        "detection": {"method": "audio_onset+pose_verify", "contact_ms": 106900,
                      "onset_peak": 0.42, "verified": True,
                      "reject_reason": None},
        "labels": {"player_slot": "left", "player_name": None, "stroke": None,
                   "quality": None, "verdict": None, "tags": [], "notes": None},
        "frames": frames,
        "measurements": {
            "space": "crop_normalized", "origin": "top_left",
            "units": {"length": "torso_heights",
                      "speed": "torso_heights_per_s"},
            "hitting_side": "right", "per_frame": "pose.json",
            "wrist_peak_speed": 2.40, "torso_height": 0.117,
            "contact_offset": 0.86, "contact_height": -0.11,
        },
        "edit": None,
    }


class TestValidateSwing(unittest.TestCase):
    def test_accepts_etl_output(self):
        self.assertEqual(schema.validate_swing(make_swing()), [])

    def test_accepts_reviewed_doc(self):
        """user-edit.json is the same schema with human fields filled in."""
        doc = make_swing(stage_at=106900)
        doc["labels"].update({"player_name": "me", "stroke": "backhand",
                              "quality": 3, "verdict": "valid",
                              "tags": ["late contact"], "notes": "clipped net"})
        doc["edit"] = {"by": "wc", "at": "2026-08-16T10:12:04Z",
                       "against": "sha256:9c2b7e4d0a151f3a", "reviewed": True}
        self.assertEqual(schema.validate_swing(doc), [])

    def test_rejects_wrong_schema_version(self):
        doc = make_swing()
        doc["schema"] = "tennis.swing/99"
        self.assertTrue(any("schema" in e for e in schema.validate_swing(doc)))

    def test_rejects_missing_block(self):
        for block in ("source", "trim", "crop", "detection", "labels", "frames"):
            doc = make_swing()
            del doc[block]
            errs = schema.validate_swing(doc)
            self.assertTrue(any(block in e for e in errs),
                            "deleting %s should be an error, got %r"
                            % (block, errs))

    def test_rejects_missing_source_field(self):
        doc = make_swing()
        del doc["source"]["rotation"]
        self.assertTrue(any("rotation" in e for e in schema.validate_swing(doc)))

    def test_rejects_bad_enums(self):
        cases = [
            (("labels", "stroke"), "smash"),
            (("labels", "verdict"), "maybe"),
            (("labels", "player_slot"), "middle"),
            (("labels", "quality"), 7),
            (("detection", "reject_reason"), "vibes"),
            (("measurements", "hitting_side"), "both"),
            (("crop", "space"), "clip_pixels"),
        ]
        for (block, field), bad in cases:
            doc = make_swing()
            doc[block][field] = bad
            errs = schema.validate_swing(doc)
            self.assertTrue(any(field in e for e in errs),
                            "%s=%r should be rejected, got %r"
                            % (field, bad, errs))

    def test_rejects_bad_frame_stage(self):
        doc = make_swing()
        doc["frames"][0]["stage"] = "backswing"
        self.assertTrue(any("stage" in e for e in schema.validate_swing(doc)))

    def test_rejects_wrong_types(self):
        cases = [
            (("source", "fps"), "30"),
            (("source", "vfr"), "no"),
            (("detection", "contact_ms"), 106900.5),
            (("labels", "tags"), "late contact"),
            (("trim", "source_start_ms"), None),
        ]
        for (block, field), bad in cases:
            doc = make_swing()
            doc[block][field] = bad
            errs = schema.validate_swing(doc)
            self.assertTrue(any(field in e for e in errs),
                            "%s=%r should be rejected, got %r"
                            % (field, bad, errs))

    def test_rejects_non_monotonic_frames(self):
        """frames must be sorted by source_ms — overlay joins on it."""
        doc = make_swing()
        doc["frames"][0]["source_ms"], doc["frames"][2]["source_ms"] = (
            doc["frames"][2]["source_ms"], doc["frames"][0]["source_ms"])
        self.assertTrue(any("source_ms" in e for e in schema.validate_swing(doc)))

    def test_rejects_duplicate_source_ms(self):
        doc = make_swing()
        doc["frames"][1]["source_ms"] = doc["frames"][0]["source_ms"]
        self.assertTrue(any("source_ms" in e for e in schema.validate_swing(doc)))

    def test_allows_null_measurements(self):
        """Pose may be unavailable; the rest of the doc still stands."""
        doc = make_swing()
        doc["measurements"] = None
        for f in doc["frames"]:
            f["pose_score"] = None
        self.assertEqual(schema.validate_swing(doc), [])

    def test_rejects_trim_end_before_start(self):
        doc = make_swing()
        doc["trim"]["source_end_ms"] = doc["trim"]["source_start_ms"] - 1
        self.assertTrue(schema.validate_swing(doc))

    def test_rejects_negative_crop(self):
        doc = make_swing()
        doc["crop"]["w"] = 0
        self.assertTrue(any("w" in e for e in schema.validate_swing(doc)))


class TestOverlay(unittest.TestCase):
    def test_absent_user_edit_returns_metadata(self):
        meta = make_swing()
        self.assertEqual(schema.overlay(meta, None), meta)

    def test_human_labels_win(self):
        meta = make_swing()
        edit = make_swing()
        edit["labels"].update({"player_name": "me", "stroke": "backhand",
                               "quality": 3, "verdict": "valid",
                               "tags": ["off balance"], "notes": "netted"})
        got = schema.overlay(meta, edit)
        self.assertEqual(got["labels"]["stroke"], "backhand")
        self.assertEqual(got["labels"]["player_name"], "me")
        self.assertEqual(got["labels"]["quality"], 3)
        self.assertEqual(got["labels"]["tags"], ["off balance"])

    def test_null_human_label_does_not_clobber(self):
        meta = make_swing()
        meta["labels"]["player_slot"] = "right"
        edit = make_swing()
        edit["labels"]["player_slot"] = None
        self.assertEqual(
            schema.overlay(meta, edit)["labels"]["player_slot"], "right")

    def test_empty_tags_does_not_clobber(self):
        meta = make_swing()
        meta["labels"]["tags"] = ["from etl"]
        edit = make_swing()
        edit["labels"]["tags"] = []
        self.assertEqual(schema.overlay(meta, edit)["labels"]["tags"],
                         ["from etl"])

    def test_frame_stage_joins_on_source_ms(self):
        meta = make_swing()
        edit = make_swing(stage_at=106900)
        got = schema.overlay(meta, edit)
        by_ms = {f["source_ms"]: f["stage"] for f in got["frames"]}
        self.assertEqual(by_ms[106900], "contact")
        self.assertIsNone(by_ms[106834])

    def test_frame_join_survives_reordered_edit(self):
        """Array position must not matter — only source_ms."""
        meta = make_swing()
        edit = make_swing(stage_at=106900)
        edit["frames"].reverse()
        got = schema.overlay(meta, edit)
        by_ms = {f["source_ms"]: f["stage"] for f in got["frames"]}
        self.assertEqual(by_ms[106900], "contact")

    def test_etl_owned_blocks_never_overwritten(self):
        """A stale user-edit.json must not be able to rewrite ETL facts."""
        meta = make_swing()
        edit = make_swing()
        edit["detection"]["contact_ms"] = 999999
        edit["crop"]["x"] = 0
        edit["trim"]["source_start_ms"] = 0
        edit["source"]["rotation"] = 0
        edit["measurements"]["wrist_peak_speed"] = 99.0
        got = schema.overlay(meta, edit)
        self.assertEqual(got["detection"]["contact_ms"], 106900)
        self.assertEqual(got["crop"]["x"], 412)
        self.assertEqual(got["trim"]["source_start_ms"], 105400)
        self.assertEqual(got["source"]["rotation"], 90)
        self.assertEqual(got["measurements"]["wrist_peak_speed"], 2.40)

    def test_unknown_frame_is_dropped_and_reported(self):
        """Frame grid changed under the human's feet."""
        meta = make_swing()
        edit = make_swing(stage_at=106900)
        edit["frames"].append({
            "file": "frames/frame_0099.jpg", "source_ms": 200000,
            "clip_ms": 0, "offset_contact_ms": 0, "pose_score": None,
            "stage": "finish"})
        warnings = []
        got = schema.overlay(meta, edit, warn=warnings.append)
        self.assertEqual(len(got["frames"]), 3)
        self.assertNotIn(200000, [f["source_ms"] for f in got["frames"]])
        self.assertTrue(any("200000" in w for w in warnings))

    def test_frame_grid_drift_lands_on_same_moment(self):
        """Re-extracting at a finer fps must not move a human's stage label.

        30fps edit marks contact at 106900ms; the 60fps grid contains that
        same moment plus interleaved frames.
        """
        edit = make_swing(stage_at=106900, n_frames=3, base_ms=106834,
                          step_ms=33)
        finer = make_swing(n_frames=9, base_ms=106834, step_ms=16.5)
        self.assertIn(106900, [f["source_ms"] for f in finer["frames"]])
        got = schema.overlay(finer, edit, warn=lambda m: None)
        contact = [f for f in got["frames"] if f["stage"] == "contact"]
        self.assertEqual(len(contact), 1)
        self.assertEqual(contact[0]["source_ms"], 106900)

    def test_stale_against_is_flagged_but_still_overlays(self):
        meta = make_swing()
        edit = make_swing(stage_at=106900)
        edit["edit"] = {"by": "wc", "at": "2026-08-16T10:12:04Z",
                        "against": "sha256:stale", "reviewed": True}
        warnings = []
        got = schema.overlay(meta, edit, warn=warnings.append,
                             metadata_hash="sha256:fresh")
        self.assertTrue(any("stale" in w.lower() for w in warnings))
        by_ms = {f["source_ms"]: f["stage"] for f in got["frames"]}
        self.assertEqual(by_ms[106900], "contact")

    def test_matching_against_is_not_flagged(self):
        meta = make_swing()
        edit = make_swing()
        edit["edit"] = {"by": "wc", "at": "2026-08-16T10:12:04Z",
                        "against": "sha256:fresh", "reviewed": True}
        warnings = []
        schema.overlay(meta, edit, warn=warnings.append,
                       metadata_hash="sha256:fresh")
        self.assertEqual(warnings, [])

    def test_overlay_does_not_mutate_inputs(self):
        meta, edit = make_swing(), make_swing(stage_at=106900)
        before = copy.deepcopy(meta)
        schema.overlay(meta, edit)
        self.assertEqual(meta, before)

    def test_overlay_output_validates(self):
        meta = make_swing()
        edit = make_swing(stage_at=106900)
        edit["labels"]["stroke"] = "backhand"
        self.assertEqual(schema.validate_swing(schema.overlay(meta, edit)), [])


class TestSessionDoc(unittest.TestCase):
    def make_session(self):
        return {
            "schema": schema.SESSION_SCHEMA,
            "source": make_swing()["source"],
            "settings": {"onset_k": 8.0, "settings_hash": "abc123"},
            "detection": {"candidates": 290, "verified": 240, "rejected": 50,
                          "reject_histogram": {"no_pose": 30,
                                               "wrist_too_slow": 20}},
            "players": {"mode": "side", "count": 2,
                        "zones": [{"slot": "left", "range": [0.0, 0.5],
                                   "swings": 120},
                                  {"slot": "right", "range": [0.5, 1.0],
                                   "swings": 120}]},
            "swings": [{"id": "IMG_0305/swing_001", "dir": "swings/swing_001",
                        "contact_ms": 106900, "duration_ms": 3500,
                        "player_slot": "left", "frame_count": 49,
                        "verified": True, "reviewed": False}],
        }

    def test_accepts_valid_session(self):
        self.assertEqual(schema.validate_session(self.make_session()), [])

    def test_rejects_unknown_reject_reason(self):
        doc = self.make_session()
        doc["detection"]["reject_histogram"]["gremlins"] = 1
        self.assertTrue(schema.validate_session(doc))

    def test_rejects_bad_player_mode(self):
        doc = self.make_session()
        doc["players"]["mode"] = "sideways"
        self.assertTrue(any("mode" in e for e in schema.validate_session(doc)))

    def test_rejects_missing_swing_ref_field(self):
        doc = self.make_session()
        del doc["swings"][0]["contact_ms"]
        self.assertTrue(any("contact_ms" in e
                            for e in schema.validate_session(doc)))


class TestBuilders(unittest.TestCase):
    def test_new_labels_defaults_are_valid_and_empty(self):
        labels = schema.new_labels(player_slot="left")
        self.assertEqual(labels["player_slot"], "left")
        self.assertIsNone(labels["stroke"])
        self.assertIsNone(labels["quality"])
        self.assertEqual(labels["tags"], [])

    def test_new_labels_appears_in_a_valid_doc(self):
        doc = make_swing()
        doc["labels"] = schema.new_labels(player_slot="right")
        self.assertEqual(schema.validate_swing(doc), [])

    def test_doc_hash_is_stable_and_order_independent(self):
        a = make_swing()
        b = make_swing()
        b["labels"] = dict(reversed(list(b["labels"].items())))
        self.assertEqual(schema.doc_hash(a), schema.doc_hash(b))

    def test_doc_hash_changes_with_content(self):
        a = make_swing()
        b = make_swing()
        b["detection"]["contact_ms"] = 1
        self.assertNotEqual(schema.doc_hash(a), schema.doc_hash(b))

    def test_doc_hash_ignores_edit_block(self):
        """against= must compare ETL content, not the human's own stamp."""
        a = make_swing()
        b = make_swing()
        b["edit"] = {"by": "wc", "at": "now", "against": "x", "reviewed": True}
        self.assertEqual(schema.doc_hash(a), schema.doc_hash(b))


if __name__ == "__main__":
    unittest.main()
