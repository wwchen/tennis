"""One base class for every error this package raises on purpose.

The CLI needs to tell "the input was wrong" from "the code is wrong": the
first deserves a one-line message and exit 2, the second deserves a
traceback. Enumerating the former in cli.py did not survive contact -- it
caught ProbeError and OSError, so PoseError escaped as a traceback, and the
message PoseError carries ("MediaPipe needs a window-server session...") is
the single most useful thing this package can say to a user on a headless
box. pose.py exists largely to produce it.

Each stage keeps its own subclass so callers can still be specific; the CLI
catches the base and stays correct when a new stage is added.
"""


class TennisprocError(RuntimeError):
    """An expected failure: bad input, a missing tool, a hostile environment."""
