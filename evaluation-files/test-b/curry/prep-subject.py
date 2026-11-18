#!/usr/bin/env python3
"""Curry subject assets — crops only, no layout.

This is the stage-1.5 content-swap proof: the same `spreadLayout()` that placed
the first batch gets a completely different subject, palette and copy. This
script only produces content at the aspect ratios the layout asks for (cards
3:4, accent 3:4, avatar 1:1). Swapping subjects means changing SOURCE/CROPS
here, never the layout code.

Sources are the user's `scrapbook_test/` batch. Crops keep the subject readable
at card size and avoid scoreboard bugs or unrelated players where possible.
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(ROOT, "..", "..", ".."))
SRC = os.path.join(REPO, "scrapbook_test")
OUT = os.path.join(ROOT, "photos")

NAVY = (10, 22, 42)


def crop_box(name: str, box: tuple[int, int, int, int], out_size: tuple[int, int]) -> Image.Image:
    x0, y0, x1, y1 = box
    im = Image.open(os.path.join(SRC, name)).convert("RGB")
    return im.crop((x0, y0, x1, y1)).resize(out_size, Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)

# Cards: 3:4 (480x640 = 2x the largest on-canvas card so scaling down is clean).
# card-1  celebration, full body — the emotional beat
# card-2  video card (encoded separately by prep-video.sh)
# card-3  trophies, the career evidence
CARDS = {
    "card-1.jpg": ("2-stephen-curry-adam-pantozzi.jpg", (0, 0, 267, 356)),
    "card-3.jpg": ("images-3.jpeg", (0, 48, 459, 660)),
    "card-4.jpg": ("images-4.jpeg", (0, 25, 364, 510)),
    "card-6.jpg": ("images.jpeg", (0, 110, 335, 557)),
    "card-7.jpg": (
        "detailed-view-of-the-jersey-of-golden-state-warriors-guard-stephen-curry-30.jpg",
        (90, 0, 630, 720),
    ),
}
for out, (src, box) in CARDS.items():
    crop_box(src, box, (480, 640)).save(os.path.join(OUT, out), quality=94)
    print(out, "480x640")

# Additional full-bleed accents for the sequence's second and third pages.
crop_box("2-stephen-curry-adam-pantozzi.jpg", (0, 0, 267, 356), (480, 640)).save(
    os.path.join(OUT, "accent-celebration.jpg"), quality=94
)
print("accent-celebration.jpg 480x640")
crop_box("images-4.jpeg", (0, 25, 364, 510), (480, 640)).save(
    os.path.join(OUT, "accent-shooting.jpg"), quality=94
)
print("accent-shooting.jpg 480x640")

# Accent column photo: 3:4. The jersey back is on black; blend the bottom into
# the column navy so the photo ends in the page colour instead of a hard seam.
accent = crop_box(
    "detailed-view-of-the-jersey-of-golden-state-warriors-guard-stephen-curry-30.jpg",
    (90, 0, 630, 720),
    (480, 640),
)
fade = Image.new("RGBA", accent.size, (0, 0, 0, 0))
fade_draw = ImageDraw.Draw(fade)
for y in range(accent.height):
    start = int(accent.height * 0.78)
    if y < start:
        continue
    alpha = int(255 * ((y - start) / (accent.height - start)) ** 1.5)
    fade_draw.line([(0, y), (accent.width, y)], fill=(*NAVY, alpha))
accent = Image.alpha_composite(accent.convert("RGBA"), fade).convert("RGB")
accent.save(os.path.join(OUT, "accent.jpg"), quality=94)
print("accent.jpg 480x640")

# Avatar: 1:1 face crop, circular alpha, thin gold ring (reads on cream and
# ties the gold display type to the portrait).
face = crop_box("images-2.jpeg", (225, 10, 465, 250), (300, 300))
mask = Image.new("L", (300, 300), 0)
ImageDraw.Draw(mask).ellipse((4, 4, 295, 295), fill=255)
avatar = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
avatar.paste(face, (0, 0), mask)
ImageDraw.Draw(avatar).ellipse((4, 4, 295, 295), outline=(232, 179, 74, 255), width=7)
avatar.save(os.path.join(OUT, "avatar.png"))
print("avatar.png 300x300")
