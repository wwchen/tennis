"""Tennis session video ETL.

Turns a long session video into per-shot clips, cropped per player, with
frames and metadata. Classification is deliberately not part of this
package: `stroke` and per-frame `stage` ship null for a human to fill.
"""

__version__ = "0.1.0"
