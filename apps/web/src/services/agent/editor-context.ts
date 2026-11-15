import type { Project } from "@kove-advanced/core/types/project";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { useUIStore } from "../../stores/ui-store";
import type { SelectionItem } from "../../stores/ui-store";

/**
 * Live editor context for the AI director.
 *
 * The director operates through structured tools that need concrete ids and
 * times ("split THIS clip at THIS point"). Before this existed, the model had
 * no view of the user's screen at all: `get_editor_state` reports project
 * settings and counts only, so a scrubbing user asking Monet to "add a title
 * here" left the model guessing both the time and the target clip — edits
 * landed in the wrong place or failed validation outright.
 *
 * This module samples the live UI stores at send time and renders a compact,
 * model-facing snapshot. It is appended to the system prompt by
 * `buildSystemPrompt(..., editorContext)` on every turn, so the context is
 * always fresh and never stale across turns. Headless hosts (agent-runner,
 * tests without UI stores) simply omit the block.
 */

export interface EditorContextSnapshot {
  readonly playheadSec: number;
  readonly pixelsPerSecond: number;
  readonly isScrubbing: boolean;
  readonly timelineDurationSec: number;
  readonly selectedItems: readonly SelectionItem[];
  readonly project: Project;
}

interface RawClip {
  readonly id: string;
  readonly mediaId?: string;
  readonly startTime: number;
  readonly duration: number;
  readonly speed?: number;
  readonly effects?: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly enabled: boolean;
  }>;
}

interface RawTrack {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly locked?: boolean;
  readonly hidden?: boolean;
  readonly clips: ReadonlyArray<RawClip>;
}

const MAX_LIST = 12;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function fmt(seconds: number): string {
  return Number.isFinite(seconds) ? seconds.toFixed(3) : "0.000";
}

function findClip(
  project: Project,
  clipId: string,
): { clip: RawClip; track: RawTrack; trackIndex: number } | null {
  const tracks = project.timeline.tracks as unknown as RawTrack[];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) {
      return { clip, track, trackIndex };
    }
  }
  return null;
}

function describeClipSelection(
  project: Project,
  item: SelectionItem,
): string {
  const found = findClip(project, item.id);
  if (!found) {
    // Stale selection (e.g. the clip was split/removed since the user clicked).
    // Still surface it — the model must know the target no longer exists.
    return `- selected: type=${item.type} id=${quote(item.id)} (no longer on the timeline — likely split or deleted)`;
  }
  const { clip, track, trackIndex } = found;
  const mediaName = clip.mediaId
    ? project.mediaLibrary?.items?.find((entry) => entry.id === clip.mediaId)
        ?.name
    : undefined;
  const end = clip.startTime + clip.duration;
  const parts = [
    `- selected: type=${item.type} id=${quote(item.id)}`,
    `trackIndex=${trackIndex} trackId=${quote(track.id)} trackName=${quote(track.name)}`,
    `startSec=${fmt(clip.startTime)} endSec=${fmt(end)} durationSec=${fmt(clip.duration)}`,
    `speed=${(clip.speed ?? 1).toFixed(2)}`,
  ];
  if (mediaName) {
    parts.push(`mediaName=${quote(cut(mediaName, 80))}`);
  }
  if (clip.effects && clip.effects.length > 0) {
    const effects = clip.effects
      .slice(0, MAX_LIST)
      .map(
        (effect) =>
          `{id=${quote(effect.id)} type=${effect.type} enabled=${effect.enabled}}`,
      )
      .join(" ");
    parts.push(`effects: ${effects}`);
  }
  return parts.join(" ");
}

function describeTextSelection(
  project: Project,
  item: SelectionItem,
): string {
  const textClip = project.textClips?.find((candidate) => candidate.id === item.id);
  if (!textClip) {
    return `- selected: type=text-clip id=${quote(item.id)} (no longer on the timeline — likely removed)`;
  }
  const end = textClip.startTime + textClip.duration;
  const parts = [
    `- selected: type=text-clip id=${quote(item.id)}`,
    `trackId=${quote(textClip.trackId)}`,
    `startSec=${fmt(textClip.startTime)} endSec=${fmt(end)} durationSec=${fmt(textClip.duration)}`,
    `text=${quote(cut(textClip.text, 80))}`,
  ];
  if (textClip.effects && textClip.effects.length > 0) {
    const effects = textClip.effects
      .slice(0, MAX_LIST)
      .map(
        (effect) =>
          `{id=${quote(effect.id)} type=${effect.type} enabled=${effect.enabled}}`,
      )
      .join(" ");
    parts.push(`effects: ${effects}`);
  }
  return parts.join(" ");
}

function describeTrackSelection(
  project: Project,
  item: SelectionItem,
): string {
  const tracks = project.timeline.tracks;
  const trackIndex = tracks.findIndex((track) => track.id === item.id);
  if (trackIndex < 0) {
    return `- selected: type=track id=${quote(item.id)} (no longer exists)`;
  }
  const track = tracks[trackIndex];
  return [
    `- selected: type=track id=${quote(item.id)}`,
    `trackIndex=${trackIndex} name=${quote(track.name)}`,
    `type=${track.type} clipCount=${track.clips.length}`,
    track.locked ? "locked=true" : "locked=false",
  ].join(" ");
}

function describeSelectionItem(project: Project, item: SelectionItem): string {
  if (item.type === "clip") {
    return describeClipSelection(project, item);
  }
  if (item.type === "track") {
    return describeTrackSelection(project, item);
  }
  if (item.type === "text-clip") {
    return describeTextSelection(project, item);
  }
  // Shape/svg/sticker overlays, markers, transitions, effects, subtitles:
  // resolve what we cheaply can, and never fail the whole context on a miss.
  const overlay =
    project.shapeClips?.find((candidate) => candidate.id === item.id) ??
    project.svgClips?.find((candidate) => candidate.id === item.id) ??
    project.stickerClips?.find((candidate) => candidate.id === item.id);
  if (overlay) {
    return [
      `- selected: type=${item.type} id=${quote(item.id)}`,
      `trackId=${quote(overlay.trackId)}`,
      `startSec=${fmt(overlay.startTime)} endSec=${fmt(overlay.startTime + overlay.duration)}`,
    ].join(" ");
  }
  return item.trackId
    ? `- selected: type=${item.type} id=${quote(item.id)} trackId=${quote(item.trackId)}`
    : `- selected: type=${item.type} id=${quote(item.id)}`;
}

/** Pure formatter — unit-tested directly with hand-made snapshots. */
export function describeEditorContext(snapshot: EditorContextSnapshot): string {
  const { project, selectedItems } = snapshot;
  // The context must never break a turn — tolerate partial projects.
  const durationSec = project?.timeline?.duration ?? 0;
  const lines = [
    "## Editor context (live UI state at the moment the user pressed send)",
    `- playheadSec: ${fmt(snapshot.playheadSec)}`,
    `- timelineDurationSec: ${fmt(durationSec)}`,
    `- scrubbing: ${snapshot.isScrubbing ? "yes" : "no"}`,
  ];
  if (selectedItems.length === 0) {
    lines.push("- selection: none");
  } else {
    lines.push(`- selectedCount: ${selectedItems.length}`);
    for (const item of selectedItems.slice(0, MAX_LIST)) {
      lines.push(describeSelectionItem(project, item));
    }
    if (selectedItems.length > MAX_LIST) {
      lines.push(`- (+${selectedItems.length - MAX_LIST} more selected items)`);
    }
  }
  lines.push(
    "Times are seconds on the timeline clock. When the user says \"here\", \"at the playhead\", \"this clip\" or \"the selected X\", use playheadSec / the selection above — never guess.",
  );
  return lines.join("\n");
}

/** Sample the live UI stores and render the context block. */
export function buildEditorContext(): string {
  const { playheadPosition, isScrubbing, pixelsPerSecond } =
    useTimelineStore.getState();
  const { selectedItems } = useUIStore.getState();
  const { project } = useProjectStore.getState();
  return describeEditorContext({
    playheadSec: playheadPosition,
    pixelsPerSecond,
    isScrubbing,
    timelineDurationSec: project?.timeline?.duration ?? 0,
    selectedItems,
    project,
  });
}
