"""Build the golden set: packs, tracks, and the five reference edits.

The references are composed with the same kernel that renders pipeline output
(`compositor.py`), which is deliberate: if the reference were built by different
code, a scorecard difference could come from the two renderers rather than from
the edit. Ground truth is written beside each reference so `selftest` can check
the analysers recover what was constructed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .compositor import CameraMove, Caption, Clip, Grade, Timeline, render_timeline
from .goldens import (
    FAMILIES,
    FPS,
    PACKS,
    SAMPLE_RATE,
    SUB_SHOT_SECONDS,
    SUB_SHOTS,
    TRACKS,
    FamilySpec,
    ReferenceGroundTruth,
    TrackGroundTruth,
    synth_track,
    synth_voice,
)

TARGET_REFERENCE_SECONDS = 24.0

CAPTION_CORPUS = [
    "the light moves first",
    "hold the frame",
    "cut on the beat",
    "let it breathe",
    "closer now",
    "this is the turn",
    "watch the hands",
    "one more pass",
    "colour settles",
    "the bed drops here",
]


def _shot_plan(family: FamilySpec, beat: float) -> list[float]:
    """Shot lengths in seconds, cycling the family's beat pattern to a target."""
    lengths: list[float] = []
    total = 0.0
    index = 0
    while total < TARGET_REFERENCE_SECONDS:
        beats = family.cut_beats[index % len(family.cut_beats)]
        duration = beats * beat
        lengths.append(duration)
        total += duration
        index += 1
    return lengths


def _pick_source(
    shot_index: int, pack_ids: list[str], duration: float
) -> tuple[str, float, float]:
    """Cycle packs so consecutive shots rarely share a look, and place the shot
    inside one sub-shot so no unintended content boundary lands inside it.

    `duration` can be most of a sub-shot (cinematic-slow's 12-beat takes), so the
    range is placed from the *end* of the sub-shot when the shot is long: the
    material stays inside one look either way.
    """
    pack_id = pack_ids[shot_index % len(pack_ids)]
    sub_shot = (shot_index // max(1, len(pack_ids))) % SUB_SHOTS
    sub_start = sub_shot * SUB_SHOT_SECONDS
    if duration >= SUB_SHOT_SECONDS:
        # Longer than a sub-shot: one look cannot hold it, so let it span exactly
        # one boundary rather than silently truncating the shot length (which
        # would move the next cut off its beat).
        return pack_id, sub_start, sub_start + duration
    if duration > SUB_SHOT_SECONDS / 2:
        start = sub_start + (SUB_SHOT_SECONDS - duration)
    else:
        start = sub_start
    return pack_id, start, start + duration


def _moves_for(family: FamilySpec, duration: float, shot_index: int) -> list[CameraMove]:
    if family.zoom == "none" or family.zoom_intensity <= 0:
        return []
    if family.zoom == "punch":
        # On the beat: a punch that starts at the cut and settles, every other shot.
        if shot_index % 2 == 0:
            return [
                CameraMove(
                    kind="punch-in",
                    start=0.0,
                    duration=min(0.6, duration * 0.6),
                    intensity=family.zoom_intensity,
                    easing="easeOutQuart",
                )
            ]
        return []
    if family.zoom == "snap":
        return [
            CameraMove(
                kind="snap-in",
                start=0.0,
                duration=min(0.25, duration * 0.4),
                intensity=family.zoom_intensity,
                easing="easeOutBack",
            )
        ]
    # push: the move runs across the whole shot
    return [
        CameraMove(
            kind="push-in",
            start=0.0,
            duration=duration,
            intensity=family.zoom_intensity,
            easing="linear",
        )
    ]


def _grade_for(family: FamilySpec) -> Grade:
    grade = family.grade
    return Grade(
        l_offset=grade["lab_l"],
        l_contrast=grade["contrast"],
        a_offset=grade["lab_a"],
        b_offset=grade["lab_b"],
        saturation=grade["saturation"],
    )


def _transition_pattern(family: FamilySpec, count: int) -> list[str]:
    """A transition sequence whose *mix* is the family's declared mix.

    Counting matters: the reference's transition proportions are one of the
    numbers the scorecard compares against, so the sequence has to realise the
    declared weights (largest-remainder allocation) rather than cycle through the
    types — cycling gives every type equal weight and would make the reference's
    own mix disagree with its spec.
    """
    slots = max(0, count - 1)  # the first clip transitions from nothing
    if slots == 0:
        return ["cut"]

    exact = {name: weight * slots for name, weight in family.transitions.items()}
    counts = {name: int(value) for name, value in exact.items()}
    remainder = sorted(
        ((value - counts[name], name) for name, value in exact.items()), reverse=True
    )
    shortfall = slots - sum(counts.values())
    for _fraction, name in remainder[:shortfall]:
        counts[name] += 1

    # Interleave: hard cuts first (they carry the rhythm), then dissolves, then
    # dips, spread evenly rather than clustered at one end.
    sequence: list[str] = []
    order = sorted(counts, key=lambda name: -counts[name])
    buckets = {name: counts[name] for name in order}
    while len(sequence) < slots:
        for name in order:
            if buckets[name] > 0:
                sequence.append(name)
                buckets[name] -= 1
                if len(sequence) >= slots:
                    break
    return ["cut", *sequence]


@dataclass
class GoldenSet:
    root: Path
    references: list[ReferenceGroundTruth]
    packs: dict[str, str]
    tracks: dict[str, TrackGroundTruth]

    def as_dict(self) -> dict:
        return {
            "root": str(self.root),
            "references": [r.as_dict() for r in self.references],
            "packs": self.packs,
            "tracks": {k: v.as_dict() for k, v in self.tracks.items()},
        }


def build_golden_set(
    root: Path,
    *,
    include_references: bool = True,
    reference_ids: list[str] | None = None,
) -> GoldenSet:
    """Write packs, tracks and references under `root`; return the index."""
    packs_dir = root / "packs"
    tracks_dir = root / "tracks"
    refs_dir = root / "references"
    for directory in (packs_dir, tracks_dir, refs_dir):
        directory.mkdir(parents=True, exist_ok=True)

    # --- footage packs ----------------------------------------------------- #
    pack_paths: dict[str, str] = {}
    for pack in PACKS:
        path = packs_dir / f"{pack.id}.mp4"
        if not path.exists():
            from .goldens import render_pack

            render_pack(pack, path)
        pack_paths[pack.id] = str(path)

    # --- tracks ------------------------------------------------------------ #
    track_truth: dict[str, TrackGroundTruth] = {}
    track_paths: dict[str, str] = {}
    for spec in TRACKS:
        path = tracks_dir / f"{spec.id}.wav"
        samples, truth = synth_track(spec)
        if not path.exists():
            from .media import write_wav

            write_wav(samples, SAMPLE_RATE, path)
        track_truth[spec.id] = truth
        track_paths[spec.id] = str(path)

    if not include_references:
        return GoldenSet(root=root, references=[], packs=pack_paths, tracks=track_truth)

    # --- references -------------------------------------------------------- #
    selected = [f for f in FAMILIES if reference_ids is None or f.id in reference_ids]
    references: list[ReferenceGroundTruth] = []
    for family in selected:
        spec = next(t for t in TRACKS if t.id == family.track)
        truth = track_truth[spec.id]
        beat = 60.0 / truth.bpm
        shot_lengths = _shot_plan(family, beat)
        pack_ids = [pack.id for pack in PACKS]
        transitions = _transition_pattern(family, len(shot_lengths))
        grade = _grade_for(family)

        clips: list[Clip] = []
        caption_windows: list[list[float]] = []
        motion_events: list[dict] = []
        cursor = 0.0
        for shot_index, duration in enumerate(shot_lengths):
            pack_id, source_start, source_end = _pick_source(shot_index, pack_ids, duration)
            moves = _moves_for(family, duration, shot_index)
            for move in moves:
                motion_events.append(
                    {
                        "time": round(cursor + move.start, 3),
                        "kind": "punch-in" if "in" in move.kind else "punch-out",
                        "magnitude": round(move.intensity, 4),
                    }
                )

            captions: list[Caption] = []
            # Guard the density before inverting it: a family with no captions
            # (cinematic-slow) has density 0, and 1/0 took the whole build down.
            caption_every = (
                max(1, int(round(1 / family.caption_density)))
                if family.caption_density > 0
                else 0
            )
            if caption_every and shot_index % caption_every == 0:
                text = CAPTION_CORPUS[shot_index % len(CAPTION_CORPUS)]
                start = min(0.15, duration * 0.1)
                end = max(start + 0.4, duration - 0.15)
                captions.append(
                    Caption(
                        text=text,
                        start=start,
                        end=end,
                        style="caption" if family.caption_density >= 0.8 else "lower-third",
                        position="bottom",
                        font_size=52 if family.size == (720, 1280) else 40,
                    )
                )
                caption_windows.append([round(cursor + start, 3), round(cursor + end, 3)])

            clips.append(
                Clip(
                    source=pack_paths[pack_id],
                    source_start=source_start,
                    source_end=source_end,
                    timeline_start=cursor,
                    pack_id=pack_id,
                    grade=grade,
                    moves=moves,
                    captions=captions,
                    transition_in=transitions[shot_index],
                    transition_duration=0.5,
                    label=f"{pack_id}#{shot_index}",
                )
            )
            cursor += duration

        duration_total = cursor
        speech_windows: list[list[float]] = []
        voice_path = None
        if family.speech:
            # Speech in the second half of each shot, so ducking is measurable and
            # the bed is left alone for the first half as a control region.
            for clip, shot_duration in zip(clips, shot_lengths, strict=False):
                start = clip.timeline_start + shot_duration * 0.45
                end = clip.timeline_start + min(shot_duration - 0.1, shot_duration * 0.95)
                if end - start >= 0.3:
                    speech_windows.append([round(start, 3), round(end, 3)])
            voice = synth_voice(duration_total + 1.0, [(a, b) for a, b in speech_windows], seed=11)
            voice_path = tracks_dir / f"{family.id}-voice.wav"
            from .media import write_wav

            write_wav(voice, SAMPLE_RATE, voice_path)

        timeline = Timeline(
            clips=clips,
            fps=FPS,
            size=family.size,
            music=track_paths[spec.id],
            music_gain=family.music_gain,
            voice=str(voice_path) if voice_path else "",
            voice_gain=family.voice_gain,
            speech_windows=[(a, b) for a, b in speech_windows],
            duck_db=family.duck_db,
        )

        out_path = refs_dir / f"{family.id}.mp4"
        if not out_path.exists():
            render_timeline(timeline, out_path)

        truth_entry = ReferenceGroundTruth(
            id=family.id,
            label=family.label,
            pack_ids=sorted({clip.pack_id for clip in clips}),
            track_id=spec.id,
            bpm=truth.bpm,
            beats=truth.beats,
            cuts=[round(clip.timeline_start, 4) for clip in clips[1:]],
            shot_lengths_beats=[round(length / beat, 4) for length in shot_lengths],
            motion_events=motion_events,
            caption_windows=caption_windows,
            speech_windows=speech_windows,
            transitions=[
                {"time": round(clip.timeline_start, 3), "type": clip.transition_in}
                for clip in clips[1:]
            ],
            duck_db=family.duck_db,
            grade=dict(family.grade),
            duration=round(duration_total, 4),
            size=list(family.size),
            video=str(out_path),
            music=track_paths[spec.id],
        )
        (refs_dir / f"{family.id}.groundtruth.json").write_text(
            json.dumps(truth_entry.as_dict(), indent=2) + "\n"
        )
        references.append(truth_entry)

    (root / "golden-set.json").write_text(
        json.dumps(
            {
                "packs": pack_paths,
                "tracks": {k: v.as_dict() for k, v in track_truth.items()},
                "references": [r.as_dict() for r in references],
                "note": (
                    "Synthesised fixtures: procedurally generated footage, generated "
                    "click tracks, and reference edits composed by kove-eval. Ground "
                    "truth here is construction, not measurement — the scorecard "
                    "re-measures everything from pixels."
                ),
            },
            indent=2,
        )
        + "\n"
    )

    return GoldenSet(root=root, references=references, packs=pack_paths, tracks=track_truth)


def _golden_media_paths() -> tuple[dict[str, Path], Path, Path | None]:
    """Where the default golden set's media lives.

    Kept as one function so the pipeline cannot quietly read a different set than
    the scorecard scores against.
    """
    from .repo import DEFAULT_EVAL_ROOT

    root = DEFAULT_EVAL_ROOT
    packs = {pack.id: root / "packs" / f"{pack.id}.mp4" for pack in PACKS}
    missing = [str(path) for path in packs.values() if not path.exists()]
    if missing:
        raise FileNotFoundError(
            "golden media is not built yet; run `kove-eval build` first "
            f"(missing: {', '.join(missing[:3])})"
        )
    track = root / "tracks" / "pulse-140.wav"
    voice = None
    for candidate in sorted((root / "tracks").glob("*-voice.wav")):
        voice = candidate
        break
    return packs, track, voice
