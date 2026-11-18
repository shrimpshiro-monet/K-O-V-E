#!/usr/bin/env python3
"""Compose Curry scrapbook review sheets from the rendered outputs."""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
SCENES = [
    ("1", "CURRY — cream / navy / gold · celebration · short clip · trophies"),
    ("2", "30 — navy / cream · shooting · game clip · award"),
    ("3", "FOUR — sand / deep navy · jersey · trophies · award"),
]
CARD_TIMES = ["1.0s", "1.5s", "2.0s", "2.5s", "2.9s"]
SEQ_TIMES = [f"{0.25 + i * 0.75:.2f}s" for i in range(12)]


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


def scenes_sheet() -> None:
    tiles = []
    for key, label in SCENES:
        path = os.path.join(OUT, f"scene-{key}.png")
        if not os.path.exists(path):
            continue
        im = Image.open(path).convert("RGB")
        w = 720
        tiles.append((label, im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)))
    if not tiles:
        return
    header, pad = 30, 10
    tw, th = tiles[0][1].size
    sheet = Image.new("RGB", (tw, (th + header) * len(tiles) + pad), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    y = 0
    for label, im in tiles:
        d.text((12, y + 6), label, font=font(17), fill=(235, 235, 235))
        sheet.paste(im, (0, y + header))
        y += th + header
    sheet.save(os.path.join(OUT, "scenes.png"))
    print("scenes.png", sheet.size)


def sequence_sheet() -> None:
    frames = []
    for i, label in enumerate(SEQ_TIMES, 1):
        path = os.path.join(OUT, f"seq-{i:02d}.png")
        if not os.path.exists(path):
            continue
        frames.append((label, Image.open(path).convert("RGB")))
    if not frames:
        return
    cols, header = 3, 22
    tw, th = frames[0][1].size
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, (th + header) * rows + 8), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(frames):
        x = (i % cols) * tw
        y = (i // cols) * (th + header)
        d.text((x + 8, y + 3), f"t = {label}", font=font(14), fill=(230, 230, 230))
        sheet.paste(im, (x, y + header))
    sheet.save(os.path.join(OUT, "sequence-strip.png"))
    print("sequence-strip.png", sheet.size)


def video_sheet() -> None:
    rows = []
    for key, label in SCENES:
        frames = []
        for i, t in enumerate(CARD_TIMES, 1):
            path = os.path.join(OUT, f"scene-{key}-video-{i:02d}.png")
            if os.path.exists(path):
                frames.append((t, Image.open(path).convert("RGB")))
        if frames:
            rows.append((label, frames))
    if not rows:
        return
    header, row_header = 22, 28
    tw, th = rows[0][1][0][1].size
    width = tw * len(CARD_TIMES) + 6
    height = len(rows) * (th + header + row_header) + 8
    sheet = Image.new("RGB", (width, height), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    y = 0
    for label, frames in rows:
        d.text((10, y + 4), label, font=font(16), fill=(235, 235, 235))
        y += row_header
        for i, (t, im) in enumerate(frames):
            x = i * (tw + 1)
            d.text((x + 6, y + 2), f"t = {t}", font=font(13), fill=(225, 225, 225))
            sheet.paste(im, (x, y + header))
        y += th + header
    sheet.save(os.path.join(OUT, "video-strip.png"))
    print("video-strip.png", sheet.size)


if __name__ == "__main__":
    scenes_sheet()
    sequence_sheet()
    video_sheet()
