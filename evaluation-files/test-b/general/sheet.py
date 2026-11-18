#!/usr/bin/env python3
"""Compose stage 1.5 review sheets from the rendered outputs."""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
LABELS = {
    "A": "A — 2 cards · PLAY · ink-blue / sand · 3s motion",
    "B": "B — 4 cards · MOTION · charcoal / cream",
    "C": "C — 3 cards · CUT · warm grey / oxblood",
}


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def variants_sheet() -> None:
    tiles = []
    for key, label in LABELS.items():
        im = Image.open(os.path.join(OUT, f"variant-{key}.png")).convert("RGB")
        w = 720
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        tiles.append((label, im))
    pad, header = 10, 30
    sheet = Image.new("RGB", (720, (tiles[0][1].height + header) * len(tiles) + pad), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    f = font(18)
    y = 0
    for label, im in tiles:
        d.text((12, y + 6), label, font=f, fill=(235, 235, 235))
        sheet.paste(im, (0, y + header))
        y += im.height + header
    sheet.save(os.path.join(OUT, "variants.png"))
    print("variants.png", sheet.size)


def motion_sheet() -> None:
    times = ["0.15s", "0.50s", "0.85s", "1.20s", "2.00s", "2.90s"]
    frames = []
    for i, label in enumerate(times, 1):
        path = os.path.join(OUT, f"motion-{i:02d}.png")
        if not os.path.exists(path):
            continue
        im = Image.open(path).convert("RGB")
        frames.append((label, im))
    if not frames:
        print("no motion frames")
        return
    cols = 3
    tw, th = frames[0][1].size
    header = 22
    sheet = Image.new("RGB", (cols * tw, ((th + header) * 2) + 8), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    f = font(14)
    for i, (label, im) in enumerate(frames):
        x = (i % cols) * tw
        y = (i // cols) * (th + header)
        d.text((x + 8, y + 3), f"t = {label}", font=f, fill=(230, 230, 230))
        sheet.paste(im, (x, y + header))
    sheet.save(os.path.join(OUT, "motion-strip.png"))
    print("motion-strip.png", sheet.size)


if __name__ == "__main__":
    variants_sheet()
    motion_sheet()
