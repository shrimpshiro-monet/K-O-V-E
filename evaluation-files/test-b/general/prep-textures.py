#!/usr/bin/env python3
"""Stage 1.5 palette textures.

Page and column backgrounds are *palette assets*, not layout: the layout
function only receives a media id and places the texture in its computed rect.
Three palettes, same structure, so the only difference between variants is
colour (plus the content parameters driving the layout).

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

# page top/bottom, column top/bottom, subtle corner falloff
PALETTES = {
    "A": {  # ink-blue page / sand column, ink letters on sand
        "page": ((0x16, 0x22, 0x2C), (0x0D, 0x16, 0x1D)),
        "column": ((0xD8, 0xC3, 0xA0), (0xBF, 0xA8, 0x87)),
        "corner": 0.90,
        "noise": 1.1,
    },
    "B": {  # charcoal page / cream column
        "page": ((0x1C, 0x1C, 0x1C), (0x11, 0x11, 0x11)),
        "column": ((0xEC, 0xE6, 0xDC), (0xD8, 0xCE, 0xC0)),
        "corner": 0.90,
        "noise": 1.1,
    },
    "C": {  # warm grey page / oxblood column
        "page": ((0xD8, 0xD2, 0xC9), (0xC6, 0xBF, 0xB4)),
        "column": ((0x4D, 0x22, 0x2A), (0x34, 0x14, 0x1A)),
        "corner": 0.94,
        "noise": 1.4,
    },
}


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


def texture(path: str, w: int, h: int, top, bottom, corner: float, noise: float, seed: int) -> None:
    arr = gradient(w, h, top, bottom) * corner_falloff(w, h, corner)
    rng = np.random.default_rng(seed)
    arr = arr + rng.normal(0.0, noise, size=(h, w, 1))
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").save(path)
    print(os.path.basename(path), f"{w}x{h}")


os.makedirs(OUT, exist_ok=True)
for i, (key, p) in enumerate(sorted(PALETTES.items())):
    texture(os.path.join(OUT, f"page-{key}.png"), W, H, *p["page"], p["corner"], p["noise"], 10 + i)
    texture(os.path.join(OUT, f"column-{key}.png"), COL_W, COL_H, *p["column"], p["corner"], p["noise"], 20 + i)

print("done")
