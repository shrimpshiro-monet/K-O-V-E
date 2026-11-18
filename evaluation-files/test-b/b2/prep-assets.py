#!/usr/bin/env python3
"""B2 stage 1 asset prep — v2, all geometry measured from ref-target.png.

Key corrections vs v1 (measured, not eyeballed):
- cards: exact reference bounds, NO baked border (reference cards have only
  a 1-2px AA edge, no white frame)
- avatar: direct crop of the reference's ring+photo (143x153 at 72,47)
- panel: reference photo tiles on top (y0-381), synthesized HORIZONTAL
  slat band below (reference slats are venetian-horizontal, pitch 8px),
  plus two photo fragments (dark strip left, grey photo right)
- ALL baked letterforms removed from assets: letters render as the
  parametric text layer in the test (stage-2 animatable)
- TikTok watermark removed from fragments by mirror-tiling clean rows
- page vignette matched to reference corner value (0.84x center)
"""
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import binary_closing, binary_dilation, binary_fill_holes, gaussian_filter, label as ndlabel
import numpy as np
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
REF = Image.open(os.path.join(HERE, "assets", "ref-target.png")).convert("RGB")
W, H = REF.size
assert (W, H) == (1024, 576), (W, H)

PAGE = (211, 190, 186)  # sampled: ref page mid

# ---------------------------------------------------------------- cards
# The reference cards are physical prints photographed at an angle: their
# outlines are keystoned (measured: card2 top width 196.7, bottom 181.9), not
# rotated rectangles. A flat compositor cannot express that with rotation, so
# each card is cut out along its ACTUAL outline (alpha) and placed at its exact
# position without extra rotation. That reproduces the print instead of
# double-counting its tilt.
CARD_WINDOWS = {
    "card1": (75, 275, 265, 550),
    "card2": (275, 276, 483, 548),
    "card3": (496, 276, 707, 549),
}
_page_diff = np.abs(np.asarray(REF, dtype=np.int16) - np.array(PAGE, dtype=np.int16)).sum(axis=2)
_card_raw = _page_diff > 55

for name, (wx0, wy0, wx1, wy1) in CARD_WINDOWS.items():
    m = binary_closing(_card_raw[wy0:wy1, wx0:wx1], iterations=2)
    m = binary_fill_holes(m)
    lab, n = ndlabel(m)
    sizes = [(lab == i).sum() for i in range(1, n + 1)]
    m = lab == (1 + int(max(range(n), key=lambda i: sizes[i])))
    ys, xs = m.nonzero()
    x0, x1 = wx0 + xs.min() - 2, wx0 + xs.max() + 3
    y0, y1 = wy0 + ys.min() - 2, wy0 + ys.max() + 3
    alpha = np.zeros((y1 - y0, x1 - x0))
    alpha[wy0 - y0 + ys, wx0 - x0 + xs] = 255.0
    alpha = gaussian_filter(alpha, 0.6)
    rgba = REF.crop((x0, y0, x1, y1)).convert("RGBA")
    rgba.putalpha(Image.fromarray(alpha.astype("uint8")))
    rgba.save(os.path.join(HERE, "assets", f"{name}.png"))
    print(name, rgba.size, "at", (x0, y0))

# ---------------------------------------------------------------- avatar
# ring bbox measured: row y=124 arcs x72..214, col x=143 arcs y47..199
avatar = REF.crop((72, 47, 215, 200))
avatar.save(os.path.join(HERE, "assets", "avatar.png"))
print("avatar", avatar.size)

# ---------------------------------------------------------------- panel
# Direct crop of the whole right column. Nothing is synthesized: the giant
# letterforms and the TikTok watermark are removed by horizontal inpainting
# (the band is horizontal-slatted, so each row interpolates cleanly between
# its nearest un-masked pixels). Silhouette, fragA dark strip, fragB photo and
# the slats' horizontal shading all survive unchanged.
PW, PH = 293, 576
PANEL_X = 731
BAND_TOP = 381  # giant letters start here (tiles above)

panel_arr = np.asarray(REF.crop((PANEL_X, 0, PANEL_X + PW, PH)), dtype=np.float64)

# letter mask: cream, morphologically closed across the 2px slat lines that
# cross the letters, only in the band where the giant type exists
cream = (
    (panel_arr[:, :, 0] > 190) & (panel_arr[:, :, 1] > 168) & (panel_arr[:, :, 2] > 158)
    & ((panel_arr[:, :, 0] - panel_arr[:, :, 1]) < 30)
    & ((panel_arr[:, :, 1] - panel_arr[:, :, 2]) < 24)
)
cream[:BAND_TOP, :] = False
letter = binary_closing(cream, iterations=2)

# watermark: near-white glyphs, restricted to the region it actually occupies
watermark = np.zeros((PH, PW), dtype=bool)
watermark[430:PH, 880:PW] = np.all(panel_arr[430:PH, 880:PW] > 222, axis=2)

mask = binary_dilation(letter | watermark, iterations=2)

filled = panel_arr.copy()
for y in range(PH):
    row_mask = mask[y]
    if not row_mask.any():
        continue
    valid = ~row_mask
    if valid.sum() < 2:
        continue
    xs = np.nonzero(valid)[0]
    for c in range(3):
        filled[y, :, c] = np.interp(np.arange(PW), xs, panel_arr[y, xs, c])

panel = Image.fromarray(np.clip(filled, 0, 255).astype("uint8"), "RGB")
panel.save(os.path.join(HERE, "assets", "panel.png"))
print("panel", panel.size)

# ---------------------------------------------------------------- page bg
# reference: flat page (211,190,186) with soft CORNER shading (measured
# (30,30)=(180,159,155), (60,60)=(195,174,170)), not an edge vignette
import math

bg = Image.new("RGB", (W, H), PAGE)
bpx = bg.load()
CORNERS = [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)]
factor: dict[int, float] = {}
for y in range(H):
    for x in range(W):
        d = int(min(math.hypot(x - cx, y - cy) for cx, cy in CORNERS))
        m = factor.get(d)
        if m is None:
            m = 1.0 - 0.25 * math.exp(-(d / 70.0) ** 2)
            factor[d] = m
        bpx[x, y] = (int(PAGE[0] * m), int(PAGE[1] * m), int(PAGE[2] * m))
noise = Image.effect_noise((W, H), 14).convert("L")
bg = Image.blend(bg, Image.merge("RGB", (noise, noise, noise)), 0.035)
bg = bg.filter(ImageFilter.GaussianBlur(0.3))
bg.save(os.path.join(HERE, "assets", "page-bg.png"))
print("page-bg", bg.size)
print("DONE")
