#!/usr/bin/env python3
"""Native-rate motion capture for the B2 reference.

The earlier B2 pass sampled the reference once per second and authored motion by
guesswork. This tool changes what the analyzer looks at: every decoded frame,
then a measured scalar curve that the renderer can play back.

Subcommands
-----------
  scan    decode every frame, diff consecutive frames, find duplicate/hold runs
          and candidate shot boundaries, write `scan.json`
  band    measure a horizontal band reveal (the new shot opening from a slit).
          Writes `band.json`: per-frame top/bottom/height in pixels, plus a
          measured filmstrip.
  fit     fit easing families to a measured scalar curve and write a Motion DNA
          file. Includes a synthetic self-test that must pass before real data
          is trusted (`fit --selftest`).
  strip   compose a labelled side-by-side strip (reference vs render).

Everything is measured, nothing is guessed. The raw samples are always kept
alongside the fitted curve so a bad fit stays visible.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, Iterable, Sequence

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
DEFAULT_VIDEO = ROOT / "reference_videos_to_select" / "magazine edit, motion graphics.MP4"
OUT = HERE / "out"


# --------------------------------------------------------------------- decode


def probe(path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames",
        "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    data = json.loads(subprocess.check_output(cmd))
    stream = data["streams"][0]
    num, den = (int(x) for x in stream["r_frame_rate"].split("/"))
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": num / den,
        "frames": int(stream.get("nb_frames") or 0),
        "duration": float(data["format"]["duration"]),
    }


def decode(video: Path, cache: Path, force: bool = False) -> list[Path]:
    """Decode every frame, not one per second. Reuse a complete cache."""
    meta = probe(video)
    cache.mkdir(parents=True, exist_ok=True)
    existing = sorted(cache.glob("*.png"))
    if not force and len(existing) == meta["frames"]:
        return existing
    for item in existing:
        item.unlink()
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video), "-vsync", "0", str(cache / "%04d.png")],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    frames = sorted(cache.glob("*.png"))
    if meta["frames"] and len(frames) != meta["frames"]:
        raise SystemExit(f"decoded {len(frames)} frames, expected {meta['frames']}")
    return frames


# ----------------------------------------------------------------------- scan


def frame_diff(a: np.ndarray, b: np.ndarray) -> tuple[float, int]:
    d = cv2.absdiff(a, b)
    return float(d.mean()), int(np.count_nonzero(d))


def scan(frames: Sequence[Path], meta: dict) -> dict:
    prev: np.ndarray | None = None
    diffs: list[float] = []
    changed: list[int] = []
    for path in frames:
        cur = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if prev is not None:
            mean, pixels = frame_diff(prev, cur)
            diffs.append(round(mean, 4))
            changed.append(pixels)
        prev = cur

    duplicates = [i + 2 for i, px in enumerate(changed) if px == 0]  # 1-based frame id
    runs: list[dict] = []
    start = None
    for i, px in enumerate(changed):
        if px == 0 and start is None:
            start = i
        if px != 0 and start is not None:
            runs.append({"fromFrame": start + 2, "toFrame": i + 1, "length": i - start})
            start = None
    if start is not None:
        runs.append({"fromFrame": start + 2, "toFrame": len(changed) + 1, "length": len(changed) - start})

    arr = np.array(diffs)
    # Shot-boundary candidates: a jump well above the local median. A single
    # global threshold misses cuts inside a busy montage, so compare against a
    # rolling window and keep the strongest local peaks.
    window = 13
    candidates: list[dict] = []
    for i, value in enumerate(arr):
        lo = max(0, i - window)
        hi = min(len(arr), i + window + 1)
        local = float(np.median(arr[lo:hi]))
        if value > max(40.0, local * 2.2):
            candidates.append({
                "frame": i + 2,
                "seconds": round((i + 2) / meta["fps"], 3),
                "diff": round(float(value), 2),
                "localMedian": round(local, 2),
            })

    on_twos = float(np.mean(arr < 0.5))
    return {
        "video": str(DEFAULT_VIDEO.name),
        "fps": meta["fps"],
        "frames": len(frames),
        "duration": meta["duration"],
        "diff": {
            "min": round(float(arr.min()), 4),
            "median": round(float(np.median(arr)), 4),
            "mean": round(float(arr.mean()), 4),
            "max": round(float(arr.max()), 4),
        },
        "duplicateFrames": duplicates,
        "duplicateRuns": runs,
        "holdFraction": round(on_twos, 4),
        "cuts": candidates,
    }


# ----------------------------------------------------------------------- band


def grey_mask(frame: np.ndarray) -> np.ndarray:
    """Desaturated, reasonably bright pixels (the incoming print/wall shot)."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    return (sat < 55) & (val > 70)


def largest_run(rows: np.ndarray) -> tuple[int, int]:
    if len(rows) == 0:
        return 0, 0
    best = (int(rows[0]), int(rows[0]))
    start = prev = int(rows[0])
    for r in rows[1:]:
        r = int(r)
        if r != prev + 1:
            if prev - start > best[1] - best[0]:
                best = (start, prev)
            start = r
        prev = r
    if prev - start > best[1] - best[0]:
        best = (start, prev)
    return best


def measure_band(frames: Sequence[Path], start: int, end: int, fps: float) -> dict:
    """Measure the open height of a horizontal reveal, per native frame.

    `start`/`end` are 1-based decoded frame numbers. The band is the largest
    contiguous row run where at least 35% of the row belongs to the incoming
    shot. This is a direct pixel measurement, not a fitted guess.
    """
    path_for = lambda n: frames[n - 1]
    height = cv2.imread(str(path_for(start)), cv2.IMREAD_GRAYSCALE).shape[0]
    samples: list[dict] = []
    for n in range(start, end + 1):
        frame = cv2.imread(str(path_for(n)))
        if frame is None:
            raise SystemExit(f"missing frame {n}")
        frac = grey_mask(frame).mean(axis=1)
        rows = np.where(frac > 0.35)[0]
        top, bottom = largest_run(rows)
        samples.append({
            "frame": n,
            "seconds": round(n / fps, 4),
            "top": top,
            "bottom": bottom,
            "height": bottom - top + 1 if bottom >= top else 0,
        })
    first = samples[0]
    last = samples[-1]
    for s in samples:
        s["fraction"] = round(s["height"] / height, 4)
        s["t"] = round((s["frame"] - first["frame"]) / (last["frame"] - first["frame"]), 4)
    return {
        "source": "reference_videos_to_select/magazine edit, motion graphics.MP4",
        "fps": fps,
        "height": height,
        "startFrame": start,
        "endFrame": end,
        "samples": samples,
    }


def measure_diff_band(frames: Sequence[Path], plate: Path, start: int, end: int,
                      fps: float, threshold: float = 0.08) -> dict:
    """Measure a card's visible height by differencing against a clean plate.

    Used on our own render, where the card is the only thing that is not the
    page. `threshold` is the fraction of a row that must differ from the plate.
    """
    base = cv2.imread(str(plate))
    if base is None:
        raise SystemExit(f"missing plate {plate}")
    height = base.shape[0]
    samples: list[dict] = []
    for n in range(start, end + 1):
        frame = cv2.imread(str(frames[n - 1]))
        if frame is None:
            raise SystemExit(f"missing render frame {n}")
        delta = cv2.absdiff(frame, base).max(axis=2)
        # Count changed pixels, not a fraction of the row: the rendered card is
        # narrow and would fall under a row-fraction gate while it is small.
        rows = np.where((delta > 16).sum(axis=1) > 2)[0]
        top, bottom = largest_run(rows)
        samples.append({
            "frame": n,
            "seconds": round(n / fps, 4),
            "top": int(top),
            "bottom": int(bottom),
            "height": int(bottom - top + 1) if bottom >= top else 0,
        })
    first = samples[0]
    last = samples[-1]
    for s in samples:
        s["fraction"] = round(s["height"] / height, 4)
        s["t"] = round((s["frame"] - first["frame"]) / (last["frame"] - first["frame"]), 4)
        s["seconds"] = round((s["frame"] - first["frame"]) / fps, 4)
    return {
        "source": "render",
        "fps": fps,
        "height": height,
        "startFrame": start,
        "endFrame": end,
        "samples": samples,
    }


def save_band_strip(frames: Sequence[Path], data: dict, out: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    sel = data["samples"]
    cols = 5
    tw, th = 320, 180
    rows = math.ceil(len(sel) / cols)
    sheet = Image.new("RGB", (tw * cols, (th + 20) * rows), (18, 18, 18))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 12)
    except OSError:
        font = ImageFont.load_default()
    for i, s in enumerate(sel):
        im = Image.open(frames[s["frame"] - 1]).convert("RGB").resize((tw, th), Image.LANCZOS)
        d = ImageDraw.Draw(im)
        d.rectangle([0, s["top"] * th / data["height"], tw - 1, s["bottom"] * th / data["height"]],
                    outline=(255, 60, 60), width=2)
        x, y = (i % cols) * tw, (i // cols) * (th + 20)
        draw.text((x + 3, y + 2),
                  f'f{s["frame"]} {s["seconds"]:.2f}s  h={s["height"]} ({s["fraction"]:.2f})',
                  font=font, fill=(235, 235, 235))
        sheet.paste(im, (x, y + 20))
    sheet.save(out)
    print(f"band strip -> {out}")


def plot_curve(data: dict, out: Path, fitted: dict | None = None) -> None:
    from PIL import Image, ImageDraw, ImageFont

    w, h, pad = 900, 300, 40
    im = Image.new("RGB", (w, h), (18, 18, 18))
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
    d.rectangle([pad, pad, w - pad, h - pad], outline=(70, 70, 70))
    for i in range(6):
        x = pad + i * (w - 2 * pad) / 5
        y = h - pad - i * (h - 2 * pad) / 5
        d.line([(x, pad), (x, h - pad)], fill=(40, 40, 40))
        d.line([(pad, y), (w - pad, y)], fill=(40, 40, 40))
        d.text((4, y - 7), f"{i / 5:.1f}", font=font, fill=(150, 150, 150))
    pts = [(pad + s["t"] * (w - 2 * pad), h - pad - s["fraction"] * (h - 2 * pad))
           for s in data["samples"]]
    d.line(pts, fill=(240, 240, 240), width=2)
    for x, y in pts:
        d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(240, 240, 240))
    if fitted:
        fn = easing_function(fitted["family"], fitted.get("params", {}))
        curve = []
        for i in range(101):
            t = i / 100
            curve.append((pad + t * (w - 2 * pad), h - pad - fn(t) * (h - 2 * pad)))
        d.line(curve, fill=(232, 179, 74), width=2)
        d.text((pad, 12), f'{fitted["family"]}  rmse={fitted["rmse"]:.3f}  bic={fitted["bic"]:.1f}',
               font=font, fill=(232, 179, 74))
    im.save(out)
    print(f"curve plot -> {out}")


# ------------------------------------------------------------------------ fit

EASE: dict[str, Callable[[float], float]] = {
    "linear": lambda t: t,
    "easeInQuad": lambda t: t * t,
    "easeOutQuad": lambda t: 1 - (1 - t) ** 2,
    "easeInCubic": lambda t: t ** 3,
    "easeOutCubic": lambda t: 1 - (1 - t) ** 3,
    "easeInOutCubic": lambda t: 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2,
    "easeOutQuart": lambda t: 1 - (1 - t) ** 4,
    "easeOutQuint": lambda t: 1 - (1 - t) ** 5,
    "easeOutExpo": lambda t: 1.0 if t >= 1 else 1 - 2 ** (-10 * t),
}


def out_back(t: float, s: float = 1.70158) -> float:
    return 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2


def spring(t: float, zeta: float = 0.55, omega: float = 9.0) -> float:
    wd = omega * math.sqrt(1 - zeta * zeta)
    return 1 - math.exp(-zeta * omega * t) * (
        math.cos(wd * t) + (zeta * omega / wd) * math.sin(wd * t)
    )


def easing_function(family: str, params: dict) -> Callable[[float], float]:
    if family == "outBack":
        s = float(params.get("s", 1.70158))
        return lambda t: out_back(t, s)
    if family == "spring":
        zeta = float(params.get("zeta", 0.55))
        omega = float(params.get("omega", 9.0))
        return lambda t: spring(t, zeta, omega)
    if family == "bezier":
        x1, y1, x2, y2 = (float(params[k]) for k in ("x1", "y1", "x2", "y2"))
        return lambda t: cubic_bezier(t, x1, y1, x2, y2)
    return EASE[family]


def cubic_bezier(t: float, x1: float, y1: float, x2: float, y2: float) -> float:
    # Solve x(s) = t for s, then return y(s). Matches the renderer.
    lo, hi = 0.0, 1.0
    for _ in range(30):
        mid = (lo + hi) / 2
        x = 3 * (1 - mid) ** 2 * mid * x1 + 3 * (1 - mid) * mid ** 2 * x2 + mid ** 3
        if x < t:
            lo = mid
        else:
            hi = mid
    s = (lo + hi) / 2
    return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3


def rmse(pred: Iterable[float], obs: Iterable[float]) -> float:
    p = np.array(list(pred))
    o = np.array(list(obs))
    return float(np.sqrt(np.mean((p - o) ** 2)))


def fit_curve(samples: Sequence[dict], value_key: str = "fraction") -> dict:
    """Fit every sample in time order. Holds are included on purpose."""
    t = np.array([s["t"] for s in samples])
    v = np.array([s[value_key] for s in samples])
    v0, v1 = float(v[0]), float(v[-1])
    span = v1 - v0 if v1 != v0 else 1.0
    norm = (v - v0) / span
    results = []
    for name, fn in EASE.items():
        results.append({"family": name, "params": {}, "rmse": rmse([fn(x) for x in t], norm), "k": 0})
    results.append({"family": "outBack", "params": {"s": 1.70158},
                    "rmse": rmse([out_back(x) for x in t], norm), "k": 1})
    results.append({"family": "spring", "params": {"zeta": 0.55, "omega": 9.0},
                    "rmse": rmse([spring(x) for x in t], norm), "k": 2})
    # Free cubic bezier fallback.
    try:
        from scipy.optimize import minimize

        def loss(p: np.ndarray) -> float:
            x1, y1, x2, y2 = p
            if not (0 <= x1 <= 1 and 0 <= x2 <= 1):
                return 10.0
            return rmse([cubic_bezier(x, x1, y1, x2, y2) for x in t], norm)

        best = None
        for guess in ((0.2, 0.9, 0.4, 1.0), (0.4, 0.0, 0.2, 1.0), (0.25, 0.1, 0.25, 1.0)):
            res = minimize(loss, np.array(guess), method="Nelder-Mead",
                           options={"maxiter": 4000, "xatol": 1e-4, "fatol": 1e-6})
            if best is None or res.fun < best.fun:
                best = res
        if best is not None:
            x1, y1, x2, y2 = (float(x) for x in best.x)
            results.append({
                "family": "bezier",
                "params": {"x1": round(x1, 4), "y1": round(y1, 4),
                           "x2": round(x2, 4), "y2": round(y2, 4)},
                "rmse": float(best.fun),
                "k": 4,
            })
    except ImportError:
        pass

    n = len(t)
    for r in results:
        r["bic"] = float(n * math.log(max(r["rmse"], 1e-6) ** 2) + r["k"] * math.log(n))
        fn = easing_function(r["family"], r["params"])
        values = [fn(i / 100) for i in range(101)]
        r["monotonic"] = all(b >= a - 1e-4 for a, b in zip(values, values[1:]))
        # Overshoot is a real shape, not noise. A free bezier that wiggles
        # (up-down-up) is rejected; outBack/spring are kept.
        r["shapeOk"] = r["monotonic"] or r["family"] in ("outBack", "spring")
    results.sort(key=lambda r: r["bic"])
    shaped = [r for r in results if r["shapeOk"]]
    best = dict(shaped[0] if shaped else results[0])
    best["from"] = round(v0, 4)
    best["to"] = round(v1, 4)
    best["samples"] = n
    # The reference is stop-motion: holds are real, not noise. If no monotonic
    # easing explains the curve well, playback uses the measured samples and the
    # fitted curve is kept only as a transfer approximation.
    best["profile"] = "stepped" if best["rmse"] > 0.05 else "smooth"
    best["candidates"] = [
        {k: r[k] for k in ("family", "params", "rmse", "bic", "monotonic")}
        for r in results
    ]
    return best


def selftest() -> None:
    """Known curves in, same curves out. Run before trusting real data."""
    print("synthetic ground truth")
    cases = [
        ("linear", {"family": "linear", "params": {}}),
        ("easeOutCubic", {"family": "easeOutCubic", "params": {}}),
        ("easeInOutCubic", {"family": "easeInOutCubic", "params": {}}),
        ("outBack", {"family": "outBack", "params": {"s": 1.70158}}),
        ("bezier", {"family": "bezier", "params": {"x1": 0.2, "y1": 0.9, "x2": 0.4, "y2": 1.0}}),
    ]
    failures = 0
    for label, spec in cases:
        fn = easing_function(spec["family"], spec["params"])
        samples = [{"t": i / 12, "fraction": fn(i / 12)} for i in range(13)]
        fitted = fit_curve(samples)
        expected = spec["family"]
        ok = fitted["family"] == expected
        # Bezier may land on a named family that is numerically equivalent.
        if not ok and fitted["rmse"] < 0.01:
            ok = True
        print(f"  {label:16s} -> {fitted['family']:16s} rmse={fitted['rmse']:.4f} {'OK' if ok else 'MISS'}")
        failures += 0 if ok else 1
    # Holds: a curve with duplicate frames must keep the raw data, not invent motion.
    fn = EASE["easeOutCubic"]
    held = []
    for i in range(13):
        held.append({"t": i / 12, "fraction": fn(i / 12)})
        if i in (4, 9):
            held.append({"t": (i + 0.5) / 12, "fraction": fn(i / 12)})
    fitted = fit_curve(held)
    print(f"  held easeOutCubic -> {fitted['family']:16s} rmse={fitted['rmse']:.4f} "
          f"(raw samples kept: {fitted['samples']})")
    if failures:
        raise SystemExit(f"fitter self-test failed on {failures} case(s)")
    print("self-test passed")


# ------------------------------------------------------------------ compare


def compare_curves(ref: dict, ren: dict, render_fps: float, ref_fps: float,
                   dna: dict | None = None) -> dict:
    """Align native reference samples to rendered frames and score the curve.

    With `dna`, also score the render against the curve the renderer was told
    to play. That separates playback error from the fit's own model error.
    """
    ref_values = [s["fraction"] for s in ref["samples"]]
    ren_values = [s["fraction"] for s in ren["samples"]]
    ref_final = ref_values[-1] or 1.0
    ren_final = ren_values[-1] or 1.0
    model_fn = None
    if dna is not None:
        model_fn = easing_function(dna["fit"]["family"], dna["fit"]["params"])
    rows = []
    for i, sample in enumerate(ref["samples"]):
        # Each reference sample is the start of a held interval. Compare with
        # the first render frame that has adopted it, not the nearest frame
        # before the boundary.
        frame = max(1, min(len(ren_values), math.ceil(i * render_fps / ref_fps) + 1))
        expected = sample["fraction"] / ref_final
        measured = ren_values[frame - 1] / ren_final
        row = {
            "index": i,
            "referenceFrame": sample["frame"],
            "referenceTime": sample["seconds"],
            "renderFrame": frame,
            "reference": round(expected, 4),
            "render": round(measured, 4),
            "error": round(measured - expected, 4),
        }
        if model_fn is not None and dna is not None:
            last = max(1, len(ref["samples"]) - 1)
            model = dna["from"] + (dna["to"] - dna["from"]) * model_fn(i / last)
            row["model"] = round(model, 4)
            row["modelError"] = round(measured - model, 4)
        rows.append(row)
    errors = np.array([r["error"] for r in rows])
    report = {
        "referenceFps": ref_fps,
        "renderFps": render_fps,
        "rows": rows,
        "rmse": round(float(np.sqrt(np.mean(errors ** 2))), 5),
        "maxAbsError": round(float(np.max(np.abs(errors))), 5),
        "meanAbsError": round(float(np.mean(np.abs(errors))), 5),
    }
    if dna is not None:
        model_errors = np.array([r["modelError"] for r in rows])
        report["modelRmse"] = round(float(np.sqrt(np.mean(model_errors ** 2))), 5)
        report["modelMaxAbsError"] = round(float(np.max(np.abs(model_errors))), 5)
        report["modelMeanAbsError"] = round(float(np.mean(np.abs(model_errors))), 5)
    return report


def save_compare_plot(report: dict, out: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    w, h, pad, left = 1000, 380, 46, 58
    im = Image.new("RGB", (w, h), (18, 18, 18))
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
        bold = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 15)
    except OSError:
        font = bold = ImageFont.load_default()
    d.rectangle([left, pad, w - pad, h - pad], outline=(70, 70, 70))
    rows = report["rows"]
    span = max(1, len(rows) - 1)
    # One vertical line per source sample, so the x axis cannot imply a
    # continuous curve where the source only has 18fps steps.
    for i in range(len(rows)):
        x = left + i / span * (w - left - pad)
        d.line([(x, pad), (x, h - pad)], fill=(40, 40, 40))
        d.text((x - 4, h - pad + 8), str(i), font=font, fill=(150, 150, 150))
    d.text(((left + w - pad) / 2 - 40, h - pad + 26), "source sample (18fps)",
           font=font, fill=(150, 150, 150))
    for i in range(6):
        y = h - pad - i * (h - 2 * pad) / 5
        d.line([(left, y), (w - pad, y)], fill=(40, 40, 40))
        d.text((6, y - 7), f"{i / 5:.1f}", font=font, fill=(150, 150, 150))
    for key, color, width in (
        ("reference", (240, 240, 240), 3),
        ("render", (120, 200, 255), 2),
    ):
        pts = [
            (left + r["index"] / span * (w - left - pad),
             h - pad - r[key] * (h - 2 * pad))
            for r in rows
        ]
        d.line(pts, fill=color, width=width)
        for x, y in pts:
            d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=color)
    d.text((left, 14), "reference band height  vs  rendered card height (normalized)",
           font=bold, fill=(235, 235, 235))
    d.text((left, 32), f'rmse={report["rmse"]:.4f}   max={report["maxAbsError"]:.4f}   '
                        f'mean={report["meanAbsError"]:.4f}',
           font=font, fill=(232, 179, 74))
    d.line([(w - 250, 20), (w - 220, 20)], fill=(240, 240, 240), width=3)
    d.text((w - 214, 13), "reference", font=font, fill=(220, 220, 220))
    d.line([(w - 250, 38), (w - 220, 38)], fill=(120, 200, 255), width=2)
    d.text((w - 214, 31), "render", font=font, fill=(220, 220, 220))
    im.save(out)
    print(f"compare plot -> {out}")


def save_compare_strip(ref_frames: Sequence[Path], ren_dir: Path,
                       report: dict, out: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    rows = report["rows"]
    tw, th, head = 300, 169, 32
    sheet = Image.new("RGB", (tw * len(rows), (th + head) * 2 + 34), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), "Measured entrance — reference (top) vs render (bottom), 18fps samples",
           font=font, fill=(240, 240, 240))
    for row, (label, color) in enumerate((("REFERENCE", (232, 179, 74)), ("RENDER", (120, 200, 255)))):
        y0 = 34 + row * (th + head)
        d.text((8, y0), label, font=font, fill=color)
        for i, item in enumerate(rows):
            x = i * tw
            if row == 0:
                path = ref_frames[item["referenceFrame"] - 1]
            else:
                path = ren_dir / f'{item["renderFrame"]:04d}.png'
            if not Path(path).exists():
                continue
            im = Image.open(path).convert("RGB").resize((tw, th), Image.LANCZOS)
            value = item["reference"] if row == 0 else item["render"]
            d.text((x + 3, y0 + 16), f'{i:02d}  {value:.2f}', font=font, fill=(200, 200, 200))
            sheet.paste(im, (x, y0 + head))
    sheet.save(out)
    print(f"compare strip -> {out}")


# ---------------------------------------------------------------------- strip


def compose_strip(
    ref_frames: Sequence[Path], ref_range: tuple[int, int],
    render_dir: Path, render_range: tuple[int, int],
    out: Path, title: str,
) -> None:
    from PIL import Image, ImageDraw, ImageFont

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    ref = list(range(ref_range[0], ref_range[1] + 1))
    ren = list(range(render_range[0], render_range[1] + 1))
    count = max(len(ref), len(ren))
    tw, th, head = 300, 169, 24
    sheet = Image.new("RGB", (tw * count, (th + head) * 2 + 34), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), title, font=font, fill=(240, 240, 240))
    for row, (label, frames, base) in enumerate((
        ("REFERENCE", ref, ref_frames),
        ("RENDER", ren, None),
    )):
        y0 = 34 + row * (th + head)
        d.text((8, y0), label, font=font, fill=(232, 179, 74) if row == 0 else (120, 200, 255))
        for i in range(count):
            x = i * tw
            if row == 0 and i < len(frames):
                path = base[frames[i] - 1]
            elif row == 1 and i < len(ren):
                path = render_dir / f"{ren[i]:04d}.png"
            else:
                continue
            if not Path(path).exists():
                continue
            im = Image.open(path).convert("RGB").resize((tw, th), Image.LANCZOS)
            d.text((x + 3, y0 + 2), f"{i + 1:02d}", font=font, fill=(200, 200, 200))
            sheet.paste(im, (x, y0 + head))
    sheet.save(out)
    print(f"strip -> {out}")


# ------------------------------------------------------------------------ cli


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", type=Path, default=DEFAULT_VIDEO)
    ap.add_argument("--cache", type=Path, default=OUT / "native")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan")
    p_scan.add_argument("--force", action="store_true")

    p_band = sub.add_parser("band")
    p_band.add_argument("--start", type=int, required=True)
    p_band.add_argument("--end", type=int, required=True)
    p_band.add_argument("--out", type=Path, default=OUT / "band.json")

    p_diff = sub.add_parser("diffband")
    p_diff.add_argument("--dir", type=Path, required=True)
    p_diff.add_argument("--plate", type=Path, required=True)
    p_diff.add_argument("--start", type=int, default=1)
    p_diff.add_argument("--end", type=int, required=True)
    p_diff.add_argument("--fps", type=float, default=30.0)
    p_diff.add_argument("--out", type=Path, default=OUT / "render-band.json")

    p_self = sub.add_parser("selftest")

    p_fit = sub.add_parser("fit")
    p_fit.add_argument("--input", type=Path, default=OUT / "band.json")
    p_fit.add_argument("--out", type=Path, default=HERE / "dna" / "band-reveal.json")

    p_strip = sub.add_parser("strip")
    p_strip.add_argument("--ref-start", type=int, required=True)
    p_strip.add_argument("--ref-end", type=int, required=True)
    p_strip.add_argument("--render-dir", type=Path, required=True)
    p_strip.add_argument("--render-start", type=int, required=True)
    p_strip.add_argument("--render-end", type=int, required=True)
    p_strip.add_argument("--out", type=Path, default=OUT / "motion-strip.png")
    p_strip.add_argument("--title", default="Band reveal — reference vs render")

    p_cmp = sub.add_parser("compare")
    p_cmp.add_argument("--ref", type=Path, default=OUT / "band.json")
    p_cmp.add_argument("--render", type=Path, default=OUT / "render-band.json")
    p_cmp.add_argument("--render-dir", type=Path, default=OUT / "render/frames")
    p_cmp.add_argument("--dna", type=Path, default=HERE / "dna" / "band-reveal.json")
    p_cmp.add_argument("--out", type=Path, default=OUT / "motion-strip.png")
    p_cmp.add_argument("--report", type=Path, default=OUT / "roundtrip.json")

    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    if args.cmd == "scan":
        meta = probe(args.video)
        frames = decode(args.video, args.cache, force=args.force)
        data = scan(frames, meta)
        path = OUT / "scan.json"
        path.write_text(json.dumps(data, indent=2) + "\n")
        print(f"{data['frames']} frames @ {data['fps']:g}fps, "
              f"holdFraction={data['holdFraction']}, cuts={len(data['cuts'])} -> {path}")
        for cut in data["cuts"]:
            print(f"  f{cut['frame']:4d} {cut['seconds']:6.2f}s diff={cut['diff']:6.1f}")
        return

    if args.cmd == "band":
        meta = probe(args.video)
        frames = decode(args.video, args.cache)
        data = measure_band(frames, args.start, args.end, meta["fps"])
        args.out.write_text(json.dumps(data, indent=2) + "\n")
        save_band_strip(frames, data, OUT / "band-strip.png")
        plot_curve(data, OUT / "band-curve.png")
        print(f"band measured f{args.start}..f{args.end} -> {args.out}")
        for s in data["samples"]:
            bar = "#" * int(s["fraction"] * 40)
            print(f"  f{s['frame']:4d} {s['seconds']:6.2f}s  {s['height']:3d}px "
                  f"{s['fraction']:.3f} {bar}")
        return

    if args.cmd == "diffband":
        files = sorted(args.dir.glob("*.png"))
        if not files:
            raise SystemExit(f"no PNG frames in {args.dir}")
        data = measure_diff_band(files, args.plate, args.start, args.end, args.fps)
        args.out.write_text(json.dumps(data, indent=2) + "\n")
        print(f"render band f{args.start}..f{args.end} -> {args.out}")
        for s in data["samples"]:
            bar = "#" * int(s["fraction"] * 40)
            print(f"  f{s['frame']:4d} {s['seconds']:6.3f}s {s['height']:3d}px "
                  f"{s['fraction']:.3f} {bar}")
        return

    if args.cmd == "selftest":
        selftest()
        return

    if args.cmd == "fit":
        data = json.loads(args.input.read_text())
        fitted = fit_curve(data["samples"])
        dna = {
            "role": "card",
            "channel": "visibleHeight",
            "source": {
                "file": data["source"],
                "startFrame": data["startFrame"],
                "endFrame": data["endFrame"],
                "fps": data["fps"],
            },
            # Playback range is normalized to the band's final height: the first
            # measured slit is 2.6% open, not 0. Keeping that offset stops the
            # render from inventing a fully closed frame the reference never had.
            "from": round(fitted["from"] / fitted["to"], 4) if fitted["to"] else 0.0,
            "to": 1.0,
            "measured": {
                "fromFraction": fitted["from"],
                "toFraction": fitted["to"],
                "frameHeightPx": data["height"],
            },
            "durationFrames": data["endFrame"] - data["startFrame"],
            "durationSeconds": round((data["endFrame"] - data["startFrame"]) / data["fps"], 4),
            "fps": data["fps"],
            "profile": fitted["profile"],
            "fit": {k: fitted[k] for k in ("family", "params", "rmse", "bic", "samples")},
            "candidates": fitted["candidates"],
            # Samples are normalized 0..1 across the measured entrance; `from`
            # and `to` keep the absolute visible-height endpoints for playback.
            "samples": [
                {
                    "t": s["t"],
                    "value": round(
                        (s["fraction"] - fitted["from"]) / (fitted["to"] - fitted["from"]),
                        4,
                    ),
                }
                for s in data["samples"]
            ],
        }
        args.out.write_text(json.dumps(dna, indent=2) + "\n")
        plot_curve(data, OUT / "band-fit.png", fitted)
        best = fitted["family"]
        print(f"fit: {best} {fitted['params']} rmse={fitted['rmse']:.4f} "
              f"bic={fitted['bic']:.1f} -> {args.out}")
        for cand in fitted["candidates"]:
            print(f"  {cand['family']:16s} rmse={cand['rmse']:.4f} bic={cand['bic']:8.1f}")
        return

    if args.cmd == "strip":
        frames = decode(args.video, args.cache)
        compose_strip(
            frames, (args.ref_start, args.ref_end),
            args.render_dir, (args.render_start, args.render_end),
            args.out, args.title,
        )
        return

    if args.cmd == "compare":
        ref = json.loads(args.ref.read_text())
        ren = json.loads(args.render.read_text())
        dna = json.loads(args.dna.read_text()) if args.dna and args.dna.exists() else None
        report = compare_curves(ref, ren, float(ren["fps"]), float(ref["fps"]), dna)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        save_compare_plot(report, OUT / "motion-curves.png")
        frames = decode(args.video, args.cache)
        save_compare_strip(frames, args.render_dir, report, args.out)
        print(f'round trip: rmse={report["rmse"]:.4f} max={report["maxAbsError"]:.4f} '
              f'mean={report["meanAbsError"]:.4f} -> {args.report}')
        if "modelRmse" in report:
            print(f'playback vs dna: rmse={report["modelRmse"]:.4f} '
                  f'max={report["modelMaxAbsError"]:.4f} '
                  f'mean={report["modelMeanAbsError"]:.4f}')
        for row in report["rows"]:
            line = (f'  {row["index"]:02d} ref f{row["referenceFrame"]} '
                    f'{row["reference"]:.3f} vs render f{row["renderFrame"]} '
                    f'{row["render"]:.3f}  err={row["error"]:+.3f}')
            if "model" in row:
                line += f'  model={row["model"]:.3f}'
            print(line)
        return


if __name__ == "__main__":
    main()
