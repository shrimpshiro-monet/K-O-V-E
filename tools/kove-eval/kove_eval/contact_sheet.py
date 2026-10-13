"""The contact sheet: reference above, output below, same timestamps.

This is the artefact a human looks at, and the plan requires it beside every
score. It is laid out so a vertical glance compares the two rows — a gap that is
visible here is a gap worth naming, and the numbers on the sheet say what it
measures.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .media import frames_at, probe

TILE_WIDTH = 300
SHEET_COLUMNS = 4
LABEL_HEIGHT = 26
HEADER_HEIGHT = 34


def _label_tile(tile: np.ndarray, text: str) -> np.ndarray:
    """Draw `text` on a dark strip above the tile."""
    strip = np.full((LABEL_HEIGHT, tile.shape[1], 3), 24, dtype=np.uint8)
    cv2.putText(
        strip,
        text,
        (8, 18),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (235, 235, 235),
        1,
        cv2.LINE_AA,
    )
    return np.vstack([strip, tile])


def _header(width: int, text: str, subtitle: str = "") -> np.ndarray:
    strip = np.full((HEADER_HEIGHT, width, 3), 40, dtype=np.uint8)
    cv2.putText(
        strip,
        text[:120],
        (8, 16),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (255, 255, 255),
        1,
        cv2.LINE_AA,
    )
    if subtitle:
        cv2.putText(
            strip,
            subtitle[:200],
            (8, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            (170, 200, 255),
            1,
            cv2.LINE_AA,
        )
    return strip


def build_contact_sheet(
    reference_path: Path,
    output_path: Path,
    out_path: Path,
    *,
    columns: int = SHEET_COLUMNS,
    extra_text: str = "",
) -> Path:
    """Write the sheet and return its path."""
    ref_info = probe(reference_path)
    out_info = probe(output_path)
    span = min(ref_info.duration, out_info.duration)
    count = max(columns, columns * 3)
    timestamps = [
        round(span * (index + 0.5) / count, 3) for index in range(count)
    ]

    ref_frames = frames_at(reference_path, timestamps, width=TILE_WIDTH)
    out_frames = frames_at(output_path, timestamps, width=TILE_WIDTH)
    if not ref_frames or not out_frames:
        raise ValueError("no frames decoded for the contact sheet")

    height = max(frame.shape[0] for _, frame in ref_frames)
    width = TILE_WIDTH
    rows: list[np.ndarray] = []

    for row_index in range(0, count, columns):
        slice_ref = ref_frames[row_index : row_index + columns]
        slice_out = out_frames[row_index : row_index + columns]
        if not slice_ref or not slice_out:
            continue

        def strip(frames, prefix: str) -> np.ndarray:
            tiles = []
            for timestamp, frame in frames:
                if frame.shape[0] != height or frame.shape[1] != width:
                    frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
                tiles.append(_label_tile(frame, f"{prefix} {timestamp:.2f}s"))
            while len(tiles) < columns:
                tiles.append(np.zeros_like(tiles[0]))
            return np.hstack(tiles)

        rows.append(strip(slice_ref, "REF"))
        rows.append(strip(slice_out, "OUT"))

    sheet_width = rows[0].shape[1]
    header = _header(
        sheet_width,
        f"REFERENCE {reference_path.name}  ({ref_info.duration:.2f}s, "
        f"{ref_info.width}x{ref_info.height} @ {ref_info.fps:.2f})   |   "
        f"OUTPUT {output_path.name}  ({out_info.duration:.2f}s, "
        f"{out_info.width}x{out_info.height} @ {out_info.fps:.2f})",
        extra_text,
    )
    sheet = np.vstack([header, *rows])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), sheet)
    return out_path
