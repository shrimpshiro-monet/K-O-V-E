#!/usr/bin/env python3
"""Stage 1.5 subject assets — crops only, no layout.

The layout function decides frame size and position; this script only produces
content at the aspect ratios the layout asks for (cards 3:4, accent 3:4,
avatar 1:1). Swapping in a new subject batch means changing SOURCE/CROPS here,
never the layout code.

Stand-in subject: basketball broadcast stills (placeholder until the user's own
batch arrives). Crops deliberately avoid the broadcast scoreboard / network
bug so the test measures layout, not overlay placement.
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(ROOT, "..", "..", "mograph-p1.5", "assets"))
OUT = os.path.join(ROOT, "photos")


def cover(im: Image.Image, w: int, h: int) -> Image.Image:
    """Crop to the target aspect (centre) and resize."""
    ar = w / h
    sw, sh = im.size
    if sw / sh > ar:
        nh, nw = sh, int(round(sh * ar))
    else:
        nw, nh = sw, int(round(sw / ar))
    x, y = (sw - nw) // 2, (sh - nh) // 2
    return im.crop((x, y, x + nw, y + nh)).resize((w, h), Image.LANCZOS)


def crop_box(name: str, box: tuple[int, int, int, int], out_size: tuple[int, int]) -> Image.Image:
    x0, y0, x1, y1 = box
    im = Image.open(os.path.join(SRC, name)).convert("RGB")
    return im.crop((x0, y0, x1, y1)).resize(out_size, Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)

# Cards: 3:4 (480x640 = 2x the largest on-canvas card so scaling down is clean).
# All source crops are 3:4 boxes, chosen to exclude the scoreboard bug.
CARDS = {
    "card-1.jpg": ("photo-1.jpg", (560, 0, 920, 480)),   # two players, close
    "card-2.jpg": ("photo-1.jpg", (0, 0, 360, 480)),     # defender, left
    "card-3.jpg": ("photo-2.jpg", (250, 80, 610, 560)),  # court, mid action
    "card-4.jpg": ("photo-2.jpg", (150, 30, 510, 510)),  # bench + floor
}
for out, (src, box) in CARDS.items():
    crop_box(src, box, (480, 640)).save(os.path.join(OUT, out), quality=94)
    print(out, "480x640")

# Accent column photo: 3:4.
crop_box("photo-1.jpg", (600, 0, 960, 480), (480, 640)).save(
    os.path.join(OUT, "accent.jpg"), quality=94
)
print("accent.jpg 480x640")

# Avatar: 1:1 face crop, circular alpha, thin warm ring (visible on dark pages,
# still reads on the light one because the source is dark).
face = crop_box("photo-1.jpg", (730, 80, 870, 220), (300, 300))
mask = Image.new("L", (300, 300), 0)
ImageDraw.Draw(mask).ellipse((3, 3, 296, 296), fill=255)
avatar = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
avatar.paste(face, (0, 0), mask)
ImageDraw.Draw(avatar).ellipse((3, 3, 296, 296), outline=(232, 224, 211, 255), width=6)
avatar.save(os.path.join(OUT, "avatar.png"))
print("avatar.png 300x300")
