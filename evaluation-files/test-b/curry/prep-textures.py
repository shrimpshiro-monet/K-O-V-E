#!/usr/bin/env python3
"""Curry palette textures.

Page and column backgrounds are *palette assets*, not layout: the layout
function only receives a media id and places the texture in its computed rect.
Warm cream page / deep navy column, so the gold display type carries the
Warriors colour story without adding palette fields to the layout function.

Generated deterministically so reruns are byte-identical.
"""
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "photos")
W, H = 1024, 576
COL_W = 293
COL_H = 576

PAGE = {"top": (0xF6, 0xEE, 0xDE), "bottom": (0xE6, 0xD7, 0xBC), "corner": 0.96, "noise": 1.2, "seed": 31}
COLUMN = {"top": (0x12, 0x28, 0x4A), "bottom": (0x07, 0x13, 0x27), "corner": 0.92, "noise": 1.0, "seed": 32}
# Page 2 inverts the spread: navy paper, cream column, navy display type.
PAGE_NAVY = {"top": (0x0E, 0x1D, 0x34), "bottom": (0x06, 0x10, 0x1E), "corner": 0.92, "noise": 1.1, "seed": 33}
COLUMN_CREAM = {"top": (0xF2, 0xE8, 0xD6), "bottom": (0xDC, 0xCE, 0xB6), "corner": 0.95, "noise": 1.2, "seed": 34}
# Page 3 is a warmer sand with a deeper navy column, closing the sequence.
PAGE_SAND = {"top": (0xEF, 0xE3, 0xCD), "bottom": (0xDD, 0xCC, 0xAE), "corner": 0.95, "noise": 1.3, "seed": 35}
COLUMN_DEEP = {"top": (0x0B, 0x1A, 0x33), "bottom": (0x05, 0x0E, 0x1C), "corner": 0.90, "noise": 1.0, "seed": 36}


def gradient(w: int, h: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> np.ndarray:
    t = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    a = np.array(top, dtype=np.float32)[None, None, :]
    b = np.array(bottom, dtype=np.float32)[None, None, :]
    return np.broadcast_to(a + (b - a) * t, (h, w, 3)).copy()


def corner_falloff(w: int, h: int, strength: float) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx / (w - 1)) * 2 - 1
    ny = (yy / (h - 1)) * 2 - 1
    r = np.sqrt(nx * nx + ny * ny) / np.sqrt(2)
    f = 1.0 - (1.0 - strength) * (r ** 2)
    return f[:, :, None]


def texture(path: str, w: int, h: int, spec: dict[str, object]) -> None:
    arr = gradient(w, h, spec["top"], spec["bottom"]) * corner_falloff(w, h, spec["corner"])
    rng = np.random.default_rng(spec["seed"])
    arr = arr + rng.normal(0.0, spec["noise"], size=(h, w, 1))
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").save(path)
    print(os.path.basename(path), f"{w}x{h}")


os.makedirs(OUT, exist_ok=True)
texture(os.path.join(OUT, "page-curry.png"), W, H, PAGE)
texture(os.path.join(OUT, "column-curry.png"), COL_W, COL_H, COLUMN)
texture(os.path.join(OUT, "page-navy.png"), W, H, PAGE_NAVY)
texture(os.path.join(OUT, "column-cream.png"), COL_W, COL_H, COLUMN_CREAM)
texture(os.path.join(OUT, "page-sand.png"), W, H, PAGE_SAND)
texture(os.path.join(OUT, "column-deep.png"), COL_W, COL_H, COLUMN_DEEP)
print("done")
