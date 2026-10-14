"""kove-eval — the craft scorecard for Kove's generated edits.

Measures how far a generated edit is from a reference edit, with signals rather
than opinions: every number in `scorecard.json` comes from pixels or samples, and
`kove-eval selftest` proves each one moves when the thing it measures changes.
"""

__all__ = ["__version__"]
__version__ = "0.1.0"
