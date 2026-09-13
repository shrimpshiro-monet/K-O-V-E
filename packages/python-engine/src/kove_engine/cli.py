from __future__ import annotations

import argparse
import logging
import sys

from kove_engine.orchestrator import Orchestrator


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="kove-engine",
        description="Local video analysis engine for K.O.V.E.",
    )
    parser.add_argument("video_path", help="Path to video file")
    parser.add_argument("-o", "--output", help="Output file path (default: stdout)")
    parser.add_argument("--baseline-fps", type=float, default=1.5, help="Baseline sampling rate")
    parser.add_argument(
        "--burst-fps", type=float, default=10.0,
        help="Burst sampling rate around scene cuts",
    )
    parser.add_argument(
        "--scene-threshold", type=float, default=0.3,
        help="Scene change detection threshold",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s: %(message)s",
    )

    orchestrator = Orchestrator(
        baseline_fps=args.baseline_fps,
        burst_fps=args.burst_fps,
        scene_threshold=args.scene_threshold,
    )

    try:
        result = orchestrator.analyze(args.video_path)
        output_json = result.model_dump_json(indent=2)

        if args.output:
            with open(args.output, "w") as f:
                f.write(output_json)
            print(f"SegmentMap written to {args.output}", file=sys.stderr)
        else:
            print(output_json)

    except Exception as e:
        logging.error("Analysis failed: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
