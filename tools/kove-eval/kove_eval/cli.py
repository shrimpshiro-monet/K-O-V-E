"""`kove-eval` — the craft scorecard.

    kove-eval build      build the golden set (packs, tracks, references)
    kove-eval score      run the pipeline over every reference and score it
    kove-eval baseline   score, then store the run as the baseline to beat
    kove-eval compare    diff a run against the stored baseline
    kove-eval selftest   prove each metric separates good from bad

Every run writes `scorecard.json` plus one contact sheet per reference.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import bridge, refstills, repo, scorecard
from .build import build_golden_set
from .ffmpeg import ffmpeg_version
from .pipeline import CRAFT_VERSION, build_output
from .repo import DEFAULT_EVAL_ROOT, DEFAULT_RUNS_ROOT


def _runs_root() -> Path:
    return DEFAULT_RUNS_ROOT


def _baseline_path() -> Path:
    return DEFAULT_EVAL_ROOT / "baseline.json"


def _print_table(rows: list[scorecard.MetricRow]) -> None:
    width = max((len(row.name) for row in rows), default=10)
    print(f"  {'metric'.ljust(width)}  {'reference':>12}  {'output':>12}  {'distance':>10}  unit")
    for row in rows:
        reference = "—" if row.reference is None else f"{row.reference:.4f}"
        output = "—" if row.output is None else f"{row.output:.4f}"
        distance = "—" if row.distance is None else f"{row.distance:.4f}"
        print(
            f"  {row.name.ljust(width)}  {reference:>12}  {output:>12}  "
            f"{distance:>10}  {row.unit}"
        )


def cmd_build(args: argparse.Namespace) -> int:
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    started = time.time()
    golden = build_golden_set(
        root,
        include_references=not args.packs_only,
        reference_ids=args.only or None,
    )
    print(f"golden set at {root} in {time.time() - started:.1f}s")
    for reference in golden.references:
        print(
            f"  {reference.id}: {reference.duration:.2f}s, {len(reference.cuts)} cuts, "
            f"{reference.bpm:g} BPM, {len(reference.motion_events)} motion events, "
            f"{len(reference.caption_windows)} captions"
        )
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    root = Path(args.root)
    if not root.exists():
        print(f"no golden set at {root}; run `kove-eval build` first", file=sys.stderr)
        return 2

    run_id = args.run_id or time.strftime("%Y%m%d-%H%M%S")
    run_dir = _runs_root() / run_id
    outputs_dir = run_dir / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)

    pack_index = json.loads((root / "golden-set.json").read_text())
    references = pack_index["references"]
    if args.only:
        references = [r for r in references if r["id"] in set(args.only)]
    if not references:
        print("no references selected", file=sys.stderr)
        return 2

    scores: list[scorecard.ReferenceScore] = []
    for entry in references:
        reference_path = Path(entry["video"])
        output_path = outputs_dir / f"{entry['id']}.mp4"
        started = time.time()
        planned = build_output(
            reference_path,
            output_path,
            cache_dir=run_dir / ".cache",
            force_analysis=args.force_analysis,
            apply_snap=not args.no_snap,
        )
        print(
            f"[{entry['id']}] rendered {reference_path.name} -> {output_path.name} "
            f"in {time.time() - started:.1f}s"
        )
        for note in planned.notes:
            print(f"  · {note}")

        score = scorecard.score_pair(
            reference_path,
            output_path,
            reference_style=planned.style.as_dict(),
            out_dir=run_dir / "contact-sheets",
            reference_id=entry["id"],
            label=entry.get("label", ""),
            notes=planned.notes,
        )
        _print_table(score.rows)
        scores.append(score)

    checks = scorecard.sensitivity(run_dir / "sensitivity") if args.sensitivity else []
    non_separating = [c for c in checks if not c.separates]

    payload = {
        "craftVersion": CRAFT_VERSION,
        "runId": run_id,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "provenance": _provenance(),
        "references": [score.as_dict() for score in scores],
        "sensitivity": [check.as_dict() for check in checks],
        "sensitivityFailures": [check.metric for check in non_separating],
    }
    (run_dir / "scorecard.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f"\nscorecard: {run_dir / 'scorecard.json'}")
    print(f"contact sheets: {run_dir / 'contact-sheets'}")

    if checks:
        print("\nsensitivity — does each metric separate good from bad?")
        for check in checks:
            mark = "ok  " if check.separates else "WEAK"
            print(
                f"  {mark} {check.metric}: control {check.control_value} → "
                f"perturbed {check.perturbed_value}  ({check.perturbation})"
            )
        if non_separating:
            print(
                "\n  These metrics did not separate and must not be used as gates: "
                + ", ".join(check.metric for check in non_separating)
            )
    return 0


def _provenance() -> dict:
    """What produced these numbers, so a scorecard is readable a year later."""
    return {
        "renderer": "edl-python (kove-eval compositor)",
        "rendererNote": (
            "The product renders in the browser (WebGPU/WebCodecs + mediabunny); no "
            "browser is available in this environment, so craft output is rendered by "
            "kove-eval's Python compositor from the same EditPlan. Plan-level work "
            "(beat snapping) runs through the real production code via the vitest "
            "bridge. Rendered-vs-planned checks below measure what this renderer "
            "actually produced."
        ),
        "beatSnap": "packages/creation-schema/src/director/beat-snap.ts (via bridge)",
        "analyzers": (
            "packages/python-engine (SceneDetector, beat_grid) + kove-eval metrics"
        ),
        "ffmpeg": ffmpeg_version(),
        "python": sys.version.split()[0],
    }


def cmd_baseline(args: argparse.Namespace) -> int:
    code = cmd_score(args)
    if code != 0:
        return code
    run_dir = _runs_root() / args.run_id
    baseline = _baseline_path()
    payload = json.loads((run_dir / "scorecard.json").read_text())
    payload["isBaseline"] = True
    baseline.parent.mkdir(parents=True, exist_ok=True)
    baseline.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"\nbaseline recorded: {baseline}")
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    baseline_path = Path(args.baseline)
    if not baseline_path.exists():
        print(f"no baseline at {baseline_path}", file=sys.stderr)
        return 2
    current_path = (
        Path(args.run) if args.run else _runs_root() / args.run_id / "scorecard.json"
    )
    if not current_path.exists():
        print(f"no scorecard at {current_path}", file=sys.stderr)
        return 2

    baseline = json.loads(baseline_path.read_text())
    current = json.loads(current_path.read_text())
    baseline_by_ref = {entry["reference_id"]: entry for entry in baseline["references"]}
    current_runs = {entry["reference_id"]: entry for entry in current["references"]}

    improved: list[str] = []
    regressed: list[str] = []
    print(f"baseline {baseline.get('runId')}  →  current {current.get('runId')}")
    for reference_id, reference in sorted(current_runs.items()):
        previous = baseline_by_ref.get(reference_id)
        if previous is None:
            print(f"\n{reference_id}: new (no baseline)")
            continue
        previous_metrics = {row["name"]: row for row in previous["metrics"]}
        print(f"\n{reference_id}")
        width = max(len(row["name"]) for row in reference["metrics"])
        for row in reference["metrics"]:
            name = row["name"]
            before = previous_metrics.get(name, {}).get("distance")
            after = row.get("distance")
            if before is None or after is None:
                continue
            delta = after - before
            if abs(delta) < 1e-6:
                marker = "  ="
            elif delta < 0:
                marker = "  ↓"
                improved.append(f"{reference_id}/{name}")
            else:
                marker = "  ↑"
                regressed.append(f"{reference_id}/{name}")
            print(
                f"  {marker} {name.ljust(width)}  {before:.4f} → {after:.4f}  "
                f"({delta:+.4f} {row['unit']})"
            )

    print(f"\nimproved: {len(improved)}   regressed: {len(regressed)}")
    if regressed:
        print("regressed metrics: " + ", ".join(sorted(set(regressed))))
    return 0


def cmd_selftest(args: argparse.Namespace) -> int:
    run_dir = _runs_root() / (args.run_id or "selftest")
    checks = scorecard.sensitivity(run_dir / "sensitivity")
    failures = [check for check in checks if not check.separates]
    print("sensitivity — does each metric separate good from bad?")
    for check in checks:
        mark = "ok  " if check.separates else "WEAK"
        print(
            f"  {mark} {check.metric}: control {check.control_value} → "
            f"perturbed {check.perturbed_value}   [{check.perturbation}] {check.detail}"
        )
    (run_dir / "contact-sheets").mkdir(parents=True, exist_ok=True)
    (run_dir / "sensitivity.json").write_text(
        json.dumps([check.as_dict() for check in checks], indent=2) + "\n"
    )
    if failures:
        print(
            "\nThese metrics did not separate in this fixture and must not be used "
            "as gates: " + ", ".join(check.metric for check in failures)
        )
        return 1
    print("\nall metrics separated")
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    """Measure one file with no pipeline in the loop (the reference side alone)."""
    from .pipeline import analyze_reference

    path = Path(args.video)
    style = analyze_reference(path, force=True)
    print(json.dumps(style.as_dict(), indent=2))
    return 0


def cmd_refstills(args: argparse.Namespace) -> int:
    """Measure a reference supplied as stills, a frame grid, or a folder."""
    source = Path(args.source)
    interval = args.interval
    if source.is_dir():
        profile = refstills.profile_frame_dir(source, interval_seconds=interval)
    else:
        profile = refstills.profile_grid_image(source, interval_seconds=interval)

    out = Path(args.out) if args.out else source.with_suffix(".stills-profile.json")
    refstills.write_profile(profile, out)
    summary = profile.summary()
    print(f"profiled {profile.frame_count} frame(s) from {source}")
    print(f"  size {profile.size[0]}x{profile.size[1]} (aspect {profile.aspect:.3f})")
    print(f"  L mean {summary.get('L_mean')}  L std {summary.get('L_std_mean')}")
    print(
        f"  shadows(<L20) {summary.get('shadow_fraction_under_L20')}  "
        f"highlights(>L85) {summary.get('highlight_fraction_over_L85')}"
    )
    print(f"  frames with text: {summary.get('frames_with_text')}  "
          f"by band: {summary.get('text_band_counts')}")
    print(f"  layouts: {summary.get('layouts')}")
    print(f"profile: {out}")

    if args.compare:
        output_source = Path(args.compare)
        if output_source.is_dir():
            other = refstills.profile_frame_dir(output_source, interval_seconds=interval)
        else:
            other = refstills.profile_grid_image(output_source, interval_seconds=interval)
        comparison = refstills.compare_profiles(profile, other)
        print("\ncomparison (rows are the reference and the output):")
        for key in ("L_mean", "a_mean", "b_mean", "L_std", "shadows"):
            print(
                f"  {key:>10}: ref {comparison.get(f'reference_{key}')}  "
                f"out {comparison.get(f'output_{key}')}"
            )
        print(f"  text bands: ref {comparison['text_band_reference']}  "
              f"out {comparison['text_band_output']}")
        print(f"  layouts:    ref {comparison['layout_reference']}  "
              f"out {comparison['layout_output']}")
        gaps = comparison.get("gaps") or []
        if gaps:
            print("\n  named gaps:")
            for gap in gaps:
                print(f"    - {gap}")
        else:
            print("\n  no gap above threshold on the properties stills can measure")
        comparison_path = out.with_name(out.stem + ".comparison.json")
        comparison_path.write_text(json.dumps(comparison, indent=2) + "\n")
        print(f"comparison: {comparison_path}")
    return 0


def cmd_doctor(_args: argparse.Namespace) -> int:
    from .ffmpeg import FfmpegUnavailableError, ffmpeg_path

    print(f"repo root:   {repo.REPO_ROOT}")
    print(f"eval root:   {DEFAULT_EVAL_ROOT}")
    try:
        print(f"ffmpeg:      {ffmpeg_path()}")
    except FfmpegUnavailableError as exc:
        print(f"ffmpeg:      MISSING ({exc})")
        return 1
    print(f"metrics:     {CRAFT_VERSION}")
    print(f"engine src:  {repo.PYTHON_ENGINE_SRC}")
    print(f"bridge:      {bridge._vitest_binary()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kove-eval", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="build the golden set")
    build.add_argument("--root", default=str(DEFAULT_EVAL_ROOT))
    build.add_argument("--only", nargs="*", default=None)
    build.add_argument("--packs-only", action="store_true")
    build.set_defaults(func=cmd_build)

    for name, func in (("score", cmd_score), ("baseline", cmd_baseline)):
        score = sub.add_parser(name, help=__doc__)
        score.add_argument("--root", default=str(DEFAULT_EVAL_ROOT))
        score.add_argument("--run-id", default=None)
        score.add_argument("--only", nargs="*", default=None)
        score.add_argument("--no-snap", action="store_true", help="skip production beat snap")
        score.add_argument("--force-analysis", action="store_true")
        score.add_argument("--sensitivity", action="store_true", default=True)
        score.set_defaults(func=func)

    compare = sub.add_parser("compare", help="diff a run against the baseline")
    compare.add_argument("--baseline", default=str(_baseline_path()))
    compare.add_argument("--run-id", default="latest")
    compare.add_argument("--run", default=None)
    compare.set_defaults(func=cmd_compare)

    selftest = sub.add_parser("selftest", help="prove each metric separates")
    selftest.add_argument("--run-id", default=None)
    selftest.set_defaults(func=cmd_selftest)

    analyze = sub.add_parser("analyze", help="measure one file")
    analyze.add_argument("video")
    analyze.set_defaults(func=cmd_analyze)

    stills = sub.add_parser(
        "refstills", help="measure a reference given as a frame grid or stills folder"
    )
    stills.add_argument("source", help="grid image or directory of frames")
    stills.add_argument("--out", default=None)
    stills.add_argument(
        "--interval",
        type=float,
        default=None,
        help="seconds between consecutive stills, when known (enables pacing)",
    )
    stills.add_argument(
        "--compare", default=None, help="grid image or folder to compare against"
    )
    stills.set_defaults(func=cmd_refstills)

    doctor = sub.add_parser("doctor", help="check the environment")
    doctor.set_defaults(func=cmd_doctor)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
