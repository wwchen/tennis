"""`source.modified` is checked when present and tolerated when absent."""

import copy
import json
import os
import unittest

from tennisproc import schema

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, os.pardir, "docs", "examples")


def _a_swing():
    for name in sorted(os.listdir(FIXTURE)):
        if name.endswith(".json"):
            with open(os.path.join(FIXTURE, name)) as handle:
                doc = json.load(handle)
            if "source" in doc and "frames" in doc:
                return doc
    raise unittest.SkipTest("no swing example to validate against")


class SourceModified(unittest.TestCase):

    def setUp(self):
        self.doc = _a_swing()

    def test_a_tree_rendered_before_the_field_existed_still_validates(self):
        # The regression this pins: declaring it `optional=True` failed every
        # document written before the field was added, because `optional` means
        # "may be null", not "may be absent".
        doc = copy.deepcopy(self.doc)
        doc["source"].pop("modified", None)
        self.assertEqual(schema.validate_swing(doc), [])

    def test_a_date_that_is_present_must_be_a_string(self):
        doc = copy.deepcopy(self.doc)
        doc["source"]["modified"] = 1787000000
        problems = schema.validate_swing(doc)
        self.assertTrue(any("modified" in p for p in problems), problems)

    def test_a_real_date_passes(self):
        doc = copy.deepcopy(self.doc)
        doc["source"]["modified"] = "2026-08-15T18:35:09Z"
        self.assertEqual(schema.validate_swing(doc), [])


if __name__ == "__main__":
    unittest.main()
