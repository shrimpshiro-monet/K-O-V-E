#!/usr/bin/env python3
"""B2 stage 1 objective judge.

Implements the gates in PASS-CRITERIA.md exactly as written there. Nothing here
may be tuned after seeing a render; thresholds are read from GATES below and were
fixed before the judged render.

Protocol:
  1. encode BOTH ref and render through the reference's own encode
     (H.264 High L3.1, 1024x576, yuv420p, 843 kbps, 18fps, keyint 36, 2s loop)
     and decode the final frame. Neither side is judged crisper than the other.
  2. build a watermark mask from the reference (near-white ink, dilated 3px) and
     exclude those pixels from every metric.
  3. G1 geometry, G2 colour, G3 per-region SSIM, G4 whole frame.
  4. emit judged side-by-side (watermark patched on both sides) + diff heatmap.

Usage: packages/python-engine/.venv/bin/python evaluation-files/test-b/b2/objective-diff.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import binary_dilation, gaussian_filter

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "assets", "ref-target.png")
RENDER = os.path.join(HERE, "stage1-render.png")
OUT_SIDE = os.path.join(HERE, "stage1-side-by-side-encoded.png")
OUT_HEAT = os.path.join(HERE, "stage1-diff-heatmap.png")
OUT_JSON = os.path.join(HERE, "stage1-metrics.json")

W, H = 1024, 576
HW, HH = 0.03 * W, 0.03 * H  # G1 tolerance

# ---------------------------------------------------------------- gates
GATES = {
    "ssim_page": 0.95,
    "ssim_photo": 0.90,
    "ssim_type": 0.85,
    "ssim_full": 0.88,
    "rgb_delta": 6.0,
}

WM_RECT = (923, 454, 1015, 566)  # detected watermark ink bbox (inclusive)

REGIONS = {
    # name: (x0, y0, x1, y1, kind)  kind gates: page/photo/diag
    "page": (240, 205, 700, 270, "page"),
    "card1": (81, 281, 259, 535, "photo"),
    "card2": (281, 282, 477, 542, "photo"),
    "card3": (502, 282, 701, 543, "photo"),
    "avatar": (72, 47, 215, 200, "photo"),
    "panel_tiles": (731, 0, 1024, 381, "photo"),
    "body": (245, 45, 600, 200, "diag"),
    "giant_type": (731, 381, 924, 576, "diag"),
}

G3A_GATES = {
    "lines": 8,
    "edge_px": 4,
    "top_px": 4,
    "pitch_px": 1.5,
    "ink_pct": 0.15,
}

G3B_GATES = {
    "stem_px": 6.0,
    "crossbar_px": 6.0,
    "estem_px": 7.0,
    "epos_px": 7.0,
    "area_pct": 0.15,
}

SAMPLES = {
    "page": (300, 215, 680, 265),
    "letter_fill": (760, 400, 800, 420),
    # slat samples stay inside the letter-free gap (x 812..830). x=834 carries
    # the reference E's AA edge (18 cream pixels over the sample rows), which is
    # letter ink, not slat; including it compares ink against slat.
    "slat_top": (812, 450, 830, 520),
    "slat_bottom": (812, 540, 830, 565),
}
BODY_BLOCK = (245, 45, 600, 200)


# ---------------------------------------------------------------- encode parity
def encode_parity(src: str, dst: str) -> None:
    """Encode a still through the reference's exact delivery encode, decode the
    final (steady-state P) frame."""
    tmp = tempfile.mkdtemp(prefix="b2enc-")
    try:
        loop_png = os.path.join(tmp, "src.png")
        shutil.copyfile(src, loop_png)
        mp4 = os.path.join(tmp, "out.mp4")
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-loop", "1", "-i", loop_png,
                "-t", "2", "-r", "18",
                "-c:v", "libx264", "-profile:v", "high", "-level", "3.1",
                "-pix_fmt", "yuv420p",
                "-b:v", "843k", "-maxrate", "843k", "-bufsize", "1686k",
                "-x264-params", "keyint=36:min-keyint=36:scenecut=0",
                "-y", mp4,
            ],
            check=True,
        )
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", mp4, "-update", "1", "-y", dst],
            check=True,
        )
        if not os.path.exists(dst) or os.path.getsize(dst) == 0:
            raise RuntimeError(f"encode parity produced no decoded frame for {src}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- metrics
def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)


def gray(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.299, 0.587, 0.114])


def watermark_mask(ref: np.ndarray) -> np.ndarray:
    x0, y0, x1, y1 = WM_RECT
    ink = np.zeros((H, W), dtype=bool)
    reg = ref[y0:y1 + 1, x0:x1 + 1]
    ink[y0:y1 + 1, x0:x1 + 1] = np.all(reg > 225, axis=2)
    return binary_dilation(ink, iterations=3)


def ssim(a: np.ndarray, b: np.ndarray, valid: np.ndarray) -> float:
    sigma = 1.5
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = gaussian_filter(a, sigma), gaussian_filter(b, sigma)
    va = gaussian_filter(a * a, sigma) - mu_a ** 2
    vb = gaussian_filter(b * b, sigma) - mu_b ** 2
    cov = gaussian_filter(a * b, sigma) - mu_a * mu_b
    num = (2 * mu_a * mu_b + c1) * (2 * cov + c2)
    den = (mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2)
    m = num / den
    return float(m[valid].mean())


def bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def element_boxes(rgb: np.ndarray, wm: np.ndarray) -> dict[str, tuple[int, int, int, int] | None]:
    page = np.array([211, 190, 186])
    diff_from_page = np.abs(rgb - page).sum(axis=2)
    not_page = (diff_from_page > 60) & ~wm

    out: dict[str, tuple[int, int, int, int] | None] = {}

    # body: dark ink
    reg = rgb[20:260, 230:640].sum(axis=2) < 330
    m = np.zeros((H, W), dtype=bool)
    m[20:260, 230:640] = reg
    out["body"] = bbox(m)

    # cards: non-page content inside a generous window around each card
    for name, (x0, y0, x1, y1) in {
        "card1": (81, 281, 259, 535),
        "card2": (281, 282, 477, 542),
        "card3": (502, 282, 701, 543),
    }.items():
        win = np.zeros((H, W), dtype=bool)
        win[max(0, y0 - 6):min(H, y1 + 10), max(0, x0 - 6):min(W, x1 + 10)] = True
        out[name] = bbox(not_page & win)

    # avatar: saturated pixels
    sat = (rgb.max(axis=2) - rgb.min(axis=2)) > 45
    win = np.zeros((H, W), dtype=bool)
    win[10:230, 40:240] = True
    out["avatar"] = bbox(sat & win & ~wm)

    # giant type: cream letterforms
    cream = (
        (rgb[:, :, 0] > 195) & (rgb[:, :, 1] > 175) & (rgb[:, :, 2] > 165)
        & ((rgb[:, :, 0] - rgb[:, :, 1]) < 25) & ((rgb[:, :, 1] - rgb[:, :, 2]) < 20)
    )
    win = np.zeros((H, W), dtype=bool)
    win[381:576, 731:1024] = True
    out["giant_type"] = bbox(cream & win & ~wm)

    # panel edge (vertical line of the right column). Probed at rows where no
    # card overlaps the scan, starting right of card3's edge (x<=701).
    out["panel_edge_y50"] = None
    out["panel_edge_y250"] = None
    for label, y in (("panel_edge_y50", 50), ("panel_edge_y250", 250)):
        for x in range(705, 780):
            if rgb[y, x].sum() < 430:
                out[label] = (x, y, x, y)
                break
    return out


def sample_mean(rgb: np.ndarray, rect: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = rect
    return rgb[y0:y1 + 1, x0:x1 + 1].reshape(-1, 3).mean(axis=0)


def ink_darkness(rgb: np.ndarray) -> np.ndarray:
    x0, y0, x1, y1 = BODY_BLOCK
    px = rgb[y0:y1 + 1, x0:x1 + 1].reshape(-1, 3)
    lum = px.sum(axis=1)
    k = max(1, int(len(lum) * 0.02))
    return px[np.argsort(lum)[:k]].mean(axis=0)


def cream_mask(rgb: np.ndarray) -> np.ndarray:
    return (
        (rgb[:, :, 0] > 195) & (rgb[:, :, 1] > 175) & (rgb[:, :, 2] > 165)
        & ((rgb[:, :, 0] - rgb[:, :, 1]) < 25) & ((rgb[:, :, 1] - rgb[:, :, 2]) < 20)
    )


def longest_run(mask_1d: np.ndarray) -> int:
    best = 0
    start = None
    for i, v in enumerate(mask_1d):
        if v and start is None:
            start = i
        elif not v and start is not None:
            best = max(best, i - start)
            start = None
    if start is not None:
        best = max(best, len(mask_1d) - start)
    return int(best)


def body_metrics(rgb: np.ndarray, wm: np.ndarray):
    """G3a: per-line ink boxes, pitch, ink coverage.

    Row threshold is >3 dark pixels: the final line ("bre", 3 chars) must be
    counted, and a lower threshold would admit AA specks. Bands within 3px are
    merged so descenders do not split a line.
    """
    x0, x1, y0, y1 = 230, 650, 40, 205
    dark = (rgb.sum(axis=2) < 330) & ~wm
    counts = dark[y0:y1, x0:x1].sum(axis=1)
    bands: list[tuple[int, int]] = []
    start = None
    for i, c in enumerate(counts):
        on = c > 3
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start >= 4:
                bands.append((y0 + start, y0 + i - 1))
            start = None
    if start is not None and (y1 - y0) - start >= 4:
        bands.append((y0 + start, y1 - 1))
    merged: list[tuple[int, int]] = []
    for b in bands:
        if merged and b[0] - merged[-1][1] <= 3:
            merged[-1] = (merged[-1][0], b[1])
        else:
            merged.append(b)
    lines: list[tuple[int, int, int, int]] = []
    for a, b in merged:
        cols = np.nonzero(dark[a:b + 1, x0:x1].any(axis=0))[0]
        if cols.size:
            lines.append((a, b, x0 + int(cols.min()), x0 + int(cols.max())))
    return lines, int(dark[y0:y1, x0:x1].sum())


def giant_metrics(rgb: np.ndarray, wm: np.ndarray) -> dict[str, int]:
    """G3b: weight + coverage.

    - T stem: restricted to the T's own x-range (731..834). The previous range
      also contained the E, whose horizontal run is longer, so it was silently
      measuring the E.
    - E height: bounding-box height, not one column's longest cream run. The
      reference's lower letters shade toward the band colour and a single mask
      dropout row truncates a run (measured at x=845, y~563); the bbox is
      insensitive to that.
    """
    cm = cream_mask(rgb) & ~wm
    ecols = cm[381:576, 835:936]
    ys, _ = np.nonzero(ecols)
    return {
        "area": int(cm[381:576, 731:936].sum()),
        "stem": longest_run(cm[470, 731:835]),
        "crossbar": longest_run(cm[381:576, 815]),
        "estem": int(ys.max() - ys.min() + 1) if ys.size else 0,
        "etop": int(381 + ys.min()) if ys.size else 0,
        "ebottom": int(381 + ys.max()) if ys.size else 0,
    }


# ---------------------------------------------------------------- report
def main() -> int:
    ref = load(REF)
    render = load(RENDER)
    if ref.shape != render.shape:
        print(f"FAIL size mismatch ref={ref.shape} render={render.shape}")
        return 1

    enc_ref = os.path.join(HERE, "stage1-ref-encoded.png")
    enc_render = os.path.join(HERE, "stage1-render-encoded.png")
    encode_parity(REF, enc_ref)
    encode_parity(RENDER, enc_render)
    ref = load(enc_ref)
    render = load(enc_render)

    wm = watermark_mask(ref)
    wm_render = watermark_mask(render)
    wm_all = wm | wm_render

    results: dict[str, object] = {}
    failures: list[str] = []

    # ---- G1 geometry
    boxes_ref = element_boxes(ref, wm_all)
    boxes_rnd = element_boxes(render, wm_all)
    print("\nG1  geometry  (tolerance +/-30.7 x, +/-17.3 y)")
    print(f"    {'element':<16}{'ref bbox':<28}{'render bbox':<28}{'delta':<18}verdict")
    geometry: dict[str, object] = {}
    for name in boxes_ref:
        rb, nb = boxes_ref[name], boxes_rnd[name]
        if rb is None or nb is None:
            verdict = "FAIL missing"
            failures.append(f"G1 {name} missing")
        elif name.startswith("panel_edge"):
            dx = abs(rb[0] - nb[0])
            verdict = "PASS" if dx <= HW else "FAIL"
            if verdict == "FAIL":
                failures.append(f"G1 {name} dx={dx:.1f}")
            print(f"    {name:<16}{str(rb):<28}{str(nb):<28}{f'dx={dx:.0f}':<18}{verdict}")
            geometry[name] = {"ref": rb, "render": nb, "dx": dx, "pass": verdict == "PASS"}
            continue
        else:
            dx, dy = abs(rb[0] - nb[0]), abs(rb[1] - nb[1])
            dx2, dy2 = abs(rb[2] - nb[2]), abs(rb[3] - nb[3])
            dx, dy = max(dx, dx2), max(dy, dy2)
            verdict = "PASS" if dx <= HW and dy <= HH else "FAIL"
            if verdict == "FAIL":
                failures.append(f"G1 {name} dx={dx} dy={dy}")
        print(f"    {name:<16}{str(rb):<28}{str(nb):<28}{f'dx={dx:.0f} dy={dy:.0f}':<18}{verdict}")
        geometry[name] = {"ref": rb, "render": nb, "dx": dx, "dy": dy, "pass": verdict == "PASS"}
    results["g1_geometry"] = geometry

    # ---- G2 colour
    print("\nG2  colour  (mean delta per channel <= 6)")
    colour: dict[str, object] = {}
    for name, rect in SAMPLES.items():
        a, b = sample_mean(ref, rect), sample_mean(render, rect)
        d = np.abs(a - b)
        verdict = "PASS" if d.max() <= GATES["rgb_delta"] else "FAIL"
        if verdict == "FAIL":
            failures.append(f"G2 {name} d={d.round(1).tolist()}")
        print(f"    {name:<16}ref {a.round(1)}  render {b.round(1)}  "
              f"d {d.round(1)}  {verdict}")
        colour[name] = {"ref": a.round(2).tolist(), "render": b.round(2).tolist(),
                        "delta": d.round(2).tolist(), "pass": verdict == "PASS"}
    a, b = ink_darkness(ref), ink_darkness(render)
    d = np.abs(a - b)
    verdict = "PASS" if d.max() <= GATES["rgb_delta"] else "FAIL"
    if verdict == "FAIL":
        failures.append(f"G2 ink_darkness d={d.round(1).tolist()}")
    print(f"    {'ink_darkness':<16}ref {a.round(1)}  render {b.round(1)}  "
          f"d {d.round(1)}  {verdict}")
    colour["ink_darkness"] = {"ref": a.round(2).tolist(), "render": b.round(2).tolist(),
                              "delta": d.round(2).tolist(), "pass": verdict == "PASS"}
    results["g2_colour"] = colour

    # ---- G3 structure (photo/page only; type is judged by G3a/G3b)
    print("\nG3  structure  (SSIM per region; page 0.95, photo 0.90; type rows are diagnostics)")
    g_ref, g_rnd = gray(ref), gray(render)
    structure: dict[str, object] = {}
    for name, (x0, y0, x1, y1, kind) in REGIONS.items():
        valid = np.zeros((H, W), dtype=bool)
        valid[y0:y1 + 1, x0:x1 + 1] = True
        valid &= ~wm_all
        val = ssim(g_ref, g_rnd, valid)
        mad = float(np.abs(g_ref - g_rnd)[valid].mean())
        if kind == "diag":
            print(f"    {name:<16}{'diag':<7}ssim {val:.3f}  (diagnostic)   "
                  f"MAE {mad:5.1f}")
            structure[name] = {"ssim": round(val, 4), "gate": None, "mae": round(mad, 2),
                               "pass": None}
            continue
        gate = GATES[f"ssim_{kind}"]
        verdict = "PASS" if val >= gate else "FAIL"
        if verdict == "FAIL":
            failures.append(f"G3 {name} ssim={val:.3f} < {gate}")
        print(f"    {name:<16}{kind:<7}ssim {val:.3f}  (>= {gate})  "
              f"MAE {mad:5.1f}  {verdict}")
        structure[name] = {"ssim": round(val, 4), "gate": gate, "mae": round(mad, 2),
                           "pass": verdict == "PASS"}

    # ---- G3a body copy (per-line geometry + coverage)
    print("\nG3a body copy")
    ref_lines, ref_ink = body_metrics(ref, wm_all)
    rnd_lines, rnd_ink = body_metrics(render, wm_all)
    g3a: dict[str, object] = {}
    if len(ref_lines) != G3A_GATES["lines"] or len(rnd_lines) != G3A_GATES["lines"]:
        failures.append(f"G3a line count ref={len(ref_lines)} render={len(rnd_lines)}")
        print(f"    line count ref {len(ref_lines)} render {len(rnd_lines)}  FAIL")
    else:
        print(f"    line count {len(rnd_lines)}  PASS")
    worst = {"edge": 0, "top": 0}
    for i, (a, b) in enumerate(zip(ref_lines, rnd_lines), 1):
        d_left, d_right = abs(a[2] - b[2]), abs(a[3] - b[3])
        d_top = abs(a[0] - b[0])
        worst["edge"] = max(worst["edge"], d_left, d_right)
        worst["top"] = max(worst["top"], d_top)
        ok = max(d_left, d_right) <= G3A_GATES["edge_px"] and d_top <= G3A_GATES["top_px"]
        print(f"    line {i}: dL {d_left} dR {d_right} dTop {d_top}  "
              f"{'PASS' if ok else 'FAIL'}")
        if not ok:
            failures.append(f"G3a line {i} dL={d_left} dR={d_right} dTop={d_top}")
    ref_pitch = float(np.median(np.diff([l[0] for l in ref_lines]))) if len(ref_lines) > 1 else 0
    rnd_pitch = float(np.median(np.diff([l[0] for l in rnd_lines]))) if len(rnd_lines) > 1 else 0
    dpitch = abs(ref_pitch - rnd_pitch)
    ok = dpitch <= G3A_GATES["pitch_px"]
    print(f"    pitch ref {ref_pitch:.1f} render {rnd_pitch:.1f}  d {dpitch:.1f}  "
          f"{'PASS' if ok else 'FAIL'}")
    if not ok:
        failures.append(f"G3a pitch d={dpitch:.2f}")
    dink = abs(ref_ink - rnd_ink) / max(1, ref_ink)
    ok = dink <= G3A_GATES["ink_pct"]
    print(f"    ink pixels ref {ref_ink} render {rnd_ink}  d {dink * 100:.1f}%  "
          f"{'PASS' if ok else 'FAIL'}")
    if not ok:
        failures.append(f"G3a ink {dink * 100:.1f}%")
    g3a = {"ref_lines": ref_lines, "render_lines": rnd_lines,
           "pitch": [ref_pitch, rnd_pitch], "ink": [ref_ink, rnd_ink],
           "worst_edge": worst["edge"], "worst_top": worst["top"],
           "pass": not any(f.startswith("G3a") for f in failures)}
    results["g3a_body"] = g3a

    # ---- G3b giant type (weight + coverage)
    print("\nG3b giant type")
    rg, ng = giant_metrics(ref, wm_all), giant_metrics(render, wm_all)
    g3b: dict[str, object] = {}
    for key, gate_key, label in (
        ("stem", "stem_px", "T stem width"),
        ("crossbar", "crossbar_px", "crossbar thickness"),
        ("estem", "estem_px", "E bbox height"),
        ("ebottom", "epos_px", "E bbox bottom"),
    ):
        d = abs(rg[key] - ng[key])
        ok = d <= G3B_GATES[gate_key]
        print(f"    {label:<20}ref {rg[key]:4d}  render {ng[key]:4d}  d {d:3d}  "
              f"({'<= ' + str(G3B_GATES[gate_key])})  {'PASS' if ok else 'FAIL'}")
        if not ok:
            failures.append(f"G3b {key} d={d}")
        g3b[key] = {"ref": rg[key], "render": ng[key], "delta": d, "pass": ok}
    darea = abs(rg["area"] - ng["area"]) / max(1, rg["area"])
    ok = darea <= G3B_GATES["area_pct"]
    print(f"    {'cream ink area':<20}ref {rg['area']:4d}  render {ng['area']:4d}  "
          f"d {darea * 100:4.1f}%  (<={G3B_GATES['area_pct'] * 100:.0f}%)  "
          f"{'PASS' if ok else 'FAIL'}")
    if not ok:
        failures.append(f"G3b area d={darea * 100:.1f}%")
    g3b["area"] = {"ref": rg["area"], "render": ng["area"], "delta_pct": darea * 100,
                   "pass": ok}
    results["g3b_giant_type"] = g3b

    valid = ~wm_all
    full = ssim(g_ref, g_rnd, valid)
    print(f"\nG4  whole frame   ssim {full:.3f}  (diagnostic only)")
    structure["full_frame"] = {"ssim": round(full, 4), "gate": None, "pass": None}
    results["g3_structure"] = structure

    # ---- judged side-by-side (watermark patched on both sides)
    patch = (95, 37, 40)
    ri = Image.open(enc_ref).convert("RGB")
    ni = Image.open(enc_render).convert("RGB")
    for im in (ri, ni):
        d = ImageDraw.Draw(im)
        d.rectangle(list(WM_RECT), fill=patch)
    gap, label_h = 8, 26
    pair = Image.new("RGB", (W * 2 + gap, H + label_h), (32, 32, 32))
    pair.paste(ri, (0, label_h))
    pair.paste(ni, (W + gap, label_h))
    dd = ImageDraw.Draw(pair)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 17)
    except OSError:
        font = ImageFont.load_default()
    dd.text((10, 5), "REFERENCE  (same encode, watermark patched)", font=font, fill=(235, 235, 235))
    dd.text((W + gap + 10, 5), "RENDER  (same encode)", font=font, fill=(235, 235, 235))
    pair.save(OUT_SIDE)
    print(f"\nwrote {OUT_SIDE}")

    # ---- diff heatmap (amplified 4x) for humans
    diff = np.abs(ref - render).mean(axis=2)
    heat = np.zeros((H, W, 3), dtype=np.uint8)
    heat[:, :, 0] = np.clip(diff * 4 * 3, 0, 255)
    heat[:, :, 1] = np.clip(diff * 4 * 0.6, 0, 255)
    Image.fromarray(heat).save(OUT_HEAT)
    print(f"wrote {OUT_HEAT}")

    results["failures"] = failures
    results["pass"] = len(failures) == 0
    results["encode"] = "h264 high L3.1 1024x576 yuv420p 843k 18fps keyint36"
    with open(OUT_JSON, "w") as f:
        json.dump(results, f, indent=2)
    print(f"wrote {OUT_JSON}")

    print("\n" + ("STAGE 1: PASS (all objective gates)" if not failures
                  else f"STAGE 1: FAIL ({len(failures)} gate failures)"))
    for f in failures:
        print("  -", f)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
