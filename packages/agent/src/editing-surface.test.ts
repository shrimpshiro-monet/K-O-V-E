import { describe, expect, it } from "vitest";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import type { Project } from "@kove-advanced/core/types/project";

/**
 * Editing-surface proof.
 *
 * The registry tests prove the wiring; this file proves the *work*. Every
 * editing capability the agent advertises is exercised through the public tool
 * boundary and asserted on observable project state — clips actually move,
 * effects actually store, transitions actually land on the track.
 *
 * A tool that returns `ok: true` while changing nothing is the failure this
 * file exists to catch.
 */

interface AnyClip {
  id: string;
  startTime: number;
  duration: number;
  inPoint?: number;
  outPoint?: number;
  effects?: Array<{ id: string; type: string; enabled?: boolean; params?: Record<string, unknown> }>;
  audioEffects?: Array<{ id: string; type: string; enabled?: boolean }>;
  transform?: Record<string, unknown>;
  volume?: number;
  keyframes?: unknown[];
  speed?: number;
  reversed?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  colorGrading?: Record<string, unknown>;
  blendMode?: string;
  opacity?: number;
  chromaKey?: Record<string, unknown>;
  stabilization?: Record<string, unknown>;
  pitchCorrection?: boolean;
  audioAutomation?: unknown[];
}

interface AnyTrack {
  id: string;
  type: string;
  name: string;
  clips: AnyClip[];
  transitions?: Array<{ id: string; type: string; duration: number }>;
  locked?: boolean;
  muted?: boolean;
  hidden?: boolean;
  solo?: boolean;
}

function fixture(): Project {
  const clip = (id: string, startTime: number, duration: number, inPoint: number) => ({
    id,
    mediaId: "m1",
    trackId: "t1",
    startTime,
    duration,
    inPoint,
    outPoint: inPoint + duration,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  });
  const media = (id: string, name: string, type: string, duration: number) => ({
    id,
    name,
    type,
    fileHandle: null,
    blob: null,
    metadata: { duration, width: 1920, height: 1080 },
    thumbnailUrl: null,
    waveformData: null,
  });
  return {
    id: "surface-project",
    name: "Surface",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 10,
      subtitles: [],
      markers: [],
      tracks: [
        {
          id: "t1",
          type: "video",
          name: "V1",
          clips: [clip("c1", 0, 5, 0), clip("c2", 5, 5, 5)],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
        {
          id: "t2",
          type: "audio",
          name: "A1",
          clips: [],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
    mediaLibrary: {
      items: [media("m1", "footage.mp4", "video", 10), media("m2", "track.mp3", "audio", 30)],
    },
  } as unknown as Project;
}

/** Fresh host + project per test, with typed accessors. */
function setup() {
  const host = new HeadlessHost(fixture());
  const project = () => host.getProject() as unknown as {
    timeline: { tracks: AnyTrack[]; subtitles: Array<{ id: string; text: string }>; markers: Array<{ id: string; label: string }>; duration: number };
    textClips?: Array<{ id: string; text: string }>;
    shapeClips?: Array<{ id: string }>;
    svgClips?: Array<{ id: string }>;
    stickerClips?: Array<{ id: string }>;
    motionCompositions?: Array<{ id: string; layers?: Array<{ id: string }> }>;
    settings: { width: number; height: number };
    name: string;
  };
  const track = (id: string) => project().timeline.tracks.find((t) => t.id === id)!;
  const clip = (id: string) =>
    project().timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  const allTransitions = () => project().timeline.tracks.flatMap((t) => t.transitions ?? []);
  return { host, project, track, clip, allTransitions };
}

describe("editing surface: cutting and arranging", () => {
  it("adds, splits, moves, and trims clips", async () => {
    const { host, track, clip } = setup();
    expect(track("t1").clips).toHaveLength(2);

    const added = await executeTool(
      "add_clip",
      { trackId: "t1", mediaId: "m1", startTime: 20, duration: 2 },
      host,
    );
    expect(added.ok).toBe(true);
    expect(track("t1").clips).toHaveLength(3);

    const split = await executeTool("split_clip", { clipId: "c2", time: 7.5 }, host);
    expect(split.ok).toBe(true);
    // The 5–10s clip is now two clips, and the original keeps the first half.
    expect(track("t1").clips).toHaveLength(4);
    expect(clip("c2").duration).toBeCloseTo(2.5, 5);

    const moved = await executeTool("move_clip", { clipId: "c2", startTime: 1 }, host);
    expect(moved.ok).toBe(true);
    expect(clip("c2").startTime).toBeCloseTo(1, 5);

    const trimmed = await executeTool(
      "trim_clip",
      { clipId: "c1", inPoint: 0.5, outPoint: 4 },
      host,
    );
    expect(trimmed.ok).toBe(true);
    expect(clip("c1").inPoint).toBeCloseTo(0.5, 5);
    expect(clip("c1").outPoint).toBeCloseTo(4, 5);
  });

  it("slips, slides, and rolls edits without changing the cut count", async () => {
    const { host, clip } = setup();
    const before = clip("c1").inPoint!;

    const slipped = await executeTool("slip_clip", { clipId: "c1", delta: 0.5 }, host);
    expect(slipped.ok).toBe(true);
    expect(clip("c1").inPoint).not.toBe(before);

    const rolled = await executeTool(
      "roll_edit",
      { leftClipId: "c1", rightClipId: "c2", delta: 0.2 },
      host,
    );
    expect(rolled.ok).toBe(true);

    const slid = await executeTool("slide_clip", { clipId: "c2", delta: 0.2 }, host);
    expect(slid.ok).toBe(true);
  });

  it("consolidates a gapped track through the tool boundary", async () => {
    const { host, track } = setup();
    await executeTool("move_clip", { clipId: "c2", startTime: 8 }, host);
    expect(track("t1").clips.find((c) => c.id === "c2")!.startTime).toBeCloseTo(8, 5);

    const consolidated = await executeTool("consolidate_track", { trackId: "t1" }, host);
    expect(consolidated.ok).toBe(true);
    expect(track("t1").clips.find((c) => c.id === "c2")!.startTime).toBeCloseTo(5, 5);
  });

  it("refuses clip edits on a locked track and allows them again after unlock", async () => {
    const { host, clip } = setup();
    await executeTool("lock_track", { trackId: "t1", locked: true }, host);

    const blocked = await executeTool("move_clip", { clipId: "c1", startTime: 3 }, host);
    expect(blocked.ok).toBe(false);
    expect(clip("c1").startTime).toBe(0);

    await executeTool("lock_track", { trackId: "t1", locked: false }, host);
    const allowed = await executeTool("move_clip", { clipId: "c1", startTime: 3 }, host);
    expect(allowed.ok).toBe(true);
    expect(clip("c1").startTime).toBeCloseTo(3, 5);
  });
});

describe("editing surface: speed and time", () => {
  it("sets speed, ramps, reverse, pitch and stabilization", async () => {
    const { host, clip } = setup();

    expect((await executeTool("set_clip_speed", { clipId: "c1", speed: 2 }, host)).ok).toBe(true);
    expect(clip("c1").speed).toBeCloseTo(2, 5);

    const ramp = await executeTool(
      "set_speed_ramp",
      { clipId: "c1", keyframes: [{ time: 0, speed: 1 }, { time: 3, speed: 3 }] },
      host,
    );
    expect(ramp.ok).toBe(true);

    expect((await executeTool("set_clip_reverse", { clipId: "c1", reversed: true }, host)).ok).toBe(true);
    expect(clip("c1").reversed).toBe(true);

    expect(
      (await executeTool("set_clip_pitch_correction", { clipId: "c1", pitchCorrection: true }, host)).ok,
    ).toBe(true);
    expect(clip("c1").pitchCorrection).toBe(true);

    expect(
      (await executeTool(
        "set_clip_stabilization",
        { clipId: "c1", stabilization: { enabled: true, smoothness: 0.5 } },
        host,
      )).ok,
    ).toBe(true);
    expect(clip("c1").stabilization?.enabled).toBe(true);
  });
});

describe("editing surface: colour, transform and effects", () => {
  it("applies grading, transforms, blend mode and opacity to the clip", async () => {
    const { host, clip } = setup();

    expect(
      (await executeTool(
        "set_color_grading",
        { clipId: "c1", colorGrading: { exposure: 0.2, contrast: 1.15, saturation: 1.1 } },
        host,
      )).ok,
    ).toBe(true);
    expect(clip("c1").colorGrading?.exposure).toBeCloseTo(0.2, 5);

    expect(
      (await executeTool(
        "set_clip_transform",
        { clipId: "c1", transform: { position: { x: 40, y: -20 }, rotation: 5 } },
        host,
      )).ok,
    ).toBe(true);
    expect((clip("c1").transform as { rotation?: number }).rotation).toBeCloseTo(5, 5);

    expect((await executeTool("set_clip_blend_mode", { clipId: "c1", blendMode: "screen" }, host)).ok).toBe(true);
    expect(clip("c1").blendMode).toBe("screen");

    expect((await executeTool("set_clip_blend_opacity", { clipId: "c1", opacity: 0.75 }, host)).ok).toBe(true);
    // Blend opacity is stored separately from the transform's own opacity.
    expect((clip("c1") as { blendOpacity?: number }).blendOpacity).toBeCloseTo(0.75, 5);
  });

  it("stores a signature shader look with resolved params", async () => {
    const { host, clip } = setup();
    const result = await executeTool(
      "add_video_effect",
      { clipId: "c1", effectType: "vhs", params: { intensity: 0.8 } },
      host,
    );
    expect(result.ok).toBe(true);

    const stored = clip("c1").effects!.at(-1)!;
    expect(stored.type).toBe("shader");
    expect(stored.params?.shaderId).toBe("vhs");
    // intensity 0.8 maps to scanlines 0.4 / jitter 0.48 plus a default intensity.
    expect(stored.params?.scanlines).toBeCloseTo(0.4, 5);
    expect(stored.params?.jitter).toBeCloseTo(0.48, 5);
  });

  it("stores every second-wave signature look the prompt advertises", async () => {
    const { host, clip } = setup();
    for (const look of ["kaleidoscope", "mirror-tiles", "swirl", "crt-curve", "echo"]) {
      const result = await executeTool(
        "add_video_effect",
        { clipId: "c1", effectType: look, params: { intensity: 0.5 } },
        host,
      );
      expect(result.ok, look).toBe(true);
      expect(clip("c1").effects!.at(-1)!.params?.shaderId, look).toBe(look);
    }
    expect(clip("c1").effects!.length).toBe(5);
  });

  it("resolves an alias to the canonical look and rejects invented names", async () => {
    const { host, clip } = setup();
    const aliased = await executeTool(
      "add_video_effect",
      { clipId: "c1", effectType: "vortex" },
      host,
    );
    expect(aliased.ok).toBe(true);
    expect(clip("c1").effects!.at(-1)!.params?.shaderId).toBe("swirl");

    const invented = await executeTool(
      "add_video_effect",
      { clipId: "c1", effectType: "make-it-look-cool" },
      host,
    );
    expect(invented.ok).toBe(false);
    expect(invented.error?.code).toBe("UNSUPPORTED_EFFECT");
  });

  it("updates, reorders, toggles and removes effects", async () => {
    const { host, clip } = setup();
    await executeTool("add_video_effect", { clipId: "c1", effectType: "vhs" }, host);
    await executeTool("add_video_effect", { clipId: "c1", effectType: "brightness", params: { value: 0.2 } }, host);
    expect(clip("c1").effects).toHaveLength(2);

    const [first, second] = clip("c1").effects!;
    expect((await executeTool("toggle_video_effect", { clipId: "c1", effectId: first!.id, enabled: false }, host)).ok).toBe(true);
    expect(clip("c1").effects![0]!.enabled).toBe(false);

    expect(
      (await executeTool("update_video_effect", { clipId: "c1", effectId: second!.id, params: { value: 0.6 } }, host)).ok,
    ).toBe(true);

    expect(
      (await executeTool(
        "set_effect_order",
        { clipId: "c1", effectIds: [second!.id, first!.id] },
        host,
      )).ok,
    ).toBe(true);
    expect(clip("c1").effects![0]!.id).toBe(second!.id);

    expect((await executeTool("remove_video_effect", { clipId: "c1", effectId: first!.id }, host)).ok).toBe(true);
    expect(clip("c1").effects).toHaveLength(1);
  });
});

describe("editing surface: transitions", () => {
  it("accepts a second-wave transition and canonicalizes aliases", async () => {
    const { host, allTransitions } = setup();

    for (const [requested, expected] of [
      ["crossZoom", "crossZoom"],
      ["whip-zoom", "crossZoom"],
      ["Whip Zoom", "crossZoom"],
      ["paperBurn", "paperBurn"],
      ["datamosh", "pixelSort"],
    ] as const) {
      const result = await executeTool(
        "add_transition",
        { clipAId: "c1", clipBId: "c2", transitionType: requested, duration: 0.3 },
        host,
      );
      expect(result.ok, requested).toBe(true);
      expect(allTransitions().at(-1)!.type, requested).toBe(expected);
    }
  });

  it("rejects an unknown transition and explains that a hard cut needs none", async () => {
    const { host, allTransitions } = setup();

    const unknown = await executeTool(
      "add_transition",
      { clipAId: "c1", clipBId: "c2", transitionType: "teleport", duration: 0.3 },
      host,
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("UNSUPPORTED_TRANSITION");
    expect((unknown.error?.message ?? "").length).toBeGreaterThan(40);

    const hardCut = await executeTool(
      "add_transition",
      { clipAId: "c1", clipBId: "c2", transitionType: "hardCut", duration: 0.3 },
      host,
    );
    expect(hardCut.ok).toBe(false);
    expect(hardCut.summary).toContain("hard cut");

    expect(allTransitions()).toHaveLength(0);
  });

  it("updates and removes a transition", async () => {
    const { host, allTransitions } = setup();
    await executeTool(
      "add_transition",
      { clipAId: "c1", clipBId: "c2", transitionType: "crossZoom", duration: 0.3 },
      host,
    );
    const id = allTransitions()[0]!.id;

    expect((await executeTool("update_transition", { transitionId: id, duration: 0.6 }, host)).ok).toBe(true);
    expect(allTransitions()[0]!.duration).toBeCloseTo(0.6, 5);

    expect((await executeTool("remove_transition", { transitionId: id }, host)).ok).toBe(true);
    expect(allTransitions()).toHaveLength(0);
  });
});

describe("editing surface: text, graphics, subtitles and markers", () => {
  it("creates and updates a text overlay", async () => {
    const { host, project } = setup();
    const created = await executeTool(
      "create_text_clip",
      { clip: { text: "HOOK LINE", startTime: 0, duration: 1.5 } },
      host,
    );
    expect(created.ok).toBe(true);
    expect((project().textClips ?? []).length).toBeGreaterThan(0);
    expect((project().textClips ?? [])[0]!.text).toBe("HOOK LINE");

    const textId = (project().textClips ?? [])[0]!.id;
    expect((await executeTool("update_text_clip", { clipId: textId, updates: { text: "UPDATED" } }, host)).ok).toBe(true);
  });

  it("creates shape, SVG and sticker overlays", async () => {
    const { host, project } = setup();

    expect(
      (await executeTool("create_shape_clip", { clip: { id: "shape-1", shapeType: "rectangle", startTime: 0, duration: 1 } }, host)).ok,
    ).toBe(true);
    expect((project().shapeClips ?? []).length).toBe(1);

    expect(
      (await executeTool(
        "create_svg_clip",
        { clip: { id: "svg-1", svg: "<svg xmlns='http://www.w3.org/2000/svg'><circle cx='10' cy='10' r='8'/></svg>", startTime: 0, duration: 1 } },
        host,
      )).ok,
    ).toBe(true);
    expect((project().svgClips ?? []).length).toBe(1);

    expect(
      (await executeTool("create_sticker_clip", { clip: { id: "sticker-1", emoji: "🔥", startTime: 0, duration: 1 } }, host)).ok,
    ).toBe(true);
    expect((project().stickerClips ?? []).length).toBe(1);
  });

  it("adds subtitles by hand and from SRT, then styles them", async () => {
    const { host, project } = setup();

    expect((await executeTool("add_subtitle", { text: "hello", startTime: 0, endTime: 1 }, host)).ok).toBe(true);
    expect(project().timeline.subtitles).toHaveLength(1);

    const imported = await executeTool(
      "import_srt",
      { srtContent: "1\n00:00:01,000 --> 00:00:02,500\nFirst cue\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond cue\n" },
      host,
    );
    expect(imported.ok).toBe(true);
    expect(project().timeline.subtitles.length).toBeGreaterThanOrEqual(3);

    expect((await executeTool("set_subtitle_style", { style: { fontSize: 34 } }, host)).ok).toBe(true);
  });

  it("adds and updates markers", async () => {
    const { host, project } = setup();
    expect((await executeTool("add_marker", { time: 2, label: "beat", color: "#ff0000" }, host)).ok).toBe(true);
    expect(project().timeline.markers).toHaveLength(1);

    const id = project().timeline.markers[0]!.id;
    expect((await executeTool("update_marker", { markerId: id, updates: { label: "beat 2" } }, host)).ok).toBe(true);
    expect(project().timeline.markers[0]!.label).toBe("beat 2");
  });
});

describe("editing surface: audio", () => {
  it("sets volume, fades, effects and automation", async () => {
    const { host, clip } = setup();

    expect((await executeTool("set_clip_volume", { clipId: "c1", volume: 0.4 }, host)).ok).toBe(true);
    expect(clip("c1").volume).toBeCloseTo(0.4, 5);

    expect((await executeTool("set_clip_fade", { clipId: "c1", fadeIn: 0.5, fadeOut: 0.75 }, host)).ok).toBe(true);

    expect(
      (await executeTool("add_audio_effect", { clipId: "c1", effect: { id: "fx-1", type: "reverb" } }, host)).ok,
    ).toBe(true);
    expect(clip("c1").audioEffects?.length).toBeGreaterThan(0);

    expect(
      (await executeTool(
        "add_audio_automation",
        { clipId: "c1", points: [{ time: 0, value: 1 }, { time: 2, value: 0.2 }] },
        host,
      )).ok,
    ).toBe(true);
  });
});

describe("editing surface: tracks, keyframes and the raw escape hatch", () => {
  it("adds, renames, duplicates and reorders tracks", async () => {
    const { host, project } = setup();

    expect((await executeTool("add_track", { trackType: "video", name: "V2" }, host)).ok).toBe(true);
    expect(project().timeline.tracks).toHaveLength(3);

    expect((await executeTool("rename_track", { trackId: "t1", name: "Main" }, host)).ok).toBe(true);
    expect(project().timeline.tracks.find((t) => t.id === "t1")!.name).toBe("Main");

    expect((await executeTool("duplicate_track", { sourceTrackId: "t1" }, host)).ok).toBe(true);
    expect(project().timeline.tracks).toHaveLength(4);

    expect((await executeTool("reorder_track", { trackId: "t2", newPosition: 0 }, host)).ok).toBe(true);
    expect(project().timeline.tracks[0]!.id).toBe("t2");
  });

  it("adds and removes clip keyframes", async () => {
    const { host, clip } = setup();

    expect((await executeTool("add_keyframe", { clipId: "c1", property: "opacity", time: 1, value: 0.5 }, host)).ok).toBe(true);
    expect((clip("c1") as { keyframes?: unknown[] }).keyframes?.length).toBeGreaterThan(0);

    expect(
      (await executeTool(
        "set_clip_keyframes",
        { clipId: "c1", keyframes: [{ time: 0, value: 1 }, { time: 2, value: 1.4 }] },
        host,
      )).ok,
    ).toBe(true);
  });

  it("dispatches raw actions and batches through the escape hatch", async () => {
    const { host, project } = setup();

    expect((await executeTool("execute_action", { type: "track/add", params: { trackType: "video", name: "V3" } }, host)).ok).toBe(true);
    expect(project().timeline.tracks).toHaveLength(3);

    expect(
      (await executeTool(
        "batch_actions",
        { actions: [{ type: "marker/add", params: { time: 3, label: "m2", color: "#00ff00" } }] },
        host,
      )).ok,
    ).toBe(true);
    expect(project().timeline.markers.length).toBeGreaterThanOrEqual(1);
  });

  it("creates a motion composition with layers, keyframes and shader fills", async () => {
    const { host, project } = setup();

    expect((await executeTool("create_motion_composition", { name: "Comp", width: 1080, height: 1920, duration: 5 }, host)).ok).toBe(true);
    const compId = (project().motionCompositions ?? [])[0]!.id;

    expect((await executeTool("add_motion_layer", { compositionId: compId, layerType: "shape" }, host)).ok).toBe(true);
    const layerId = (project().motionCompositions ?? [])[0]!.layers![0]!.id;

    expect(
      (await executeTool(
        "set_motion_layer_transform",
        { compositionId: compId, layerId, transform: { position: { x: 100, y: 200 } } },
        host,
      )).ok,
    ).toBe(true);

    expect((await executeTool("add_motion_effect", { compositionId: compId, layerId, effectType: "blur" }, host)).ok).toBe(true);
    expect((await executeTool("add_motion_shader_effect", { compositionId: compId, layerId, shaderId: "vhs" }, host)).ok).toBe(true);

    const inserted = await executeTool("insert_motion_into_editor", { compositionId: compId }, host);
    expect(inserted.ok).toBe(true);
  });

  it("reports a headless render as unavailable rather than pretending to render", async () => {
    const { host, project } = setup();
    await executeTool("create_motion_composition", { name: "Comp", width: 1080, height: 1920, duration: 5 }, host);
    const compId = (project().motionCompositions ?? [])[0]!.id;

    const result = await executeTool("render_motion_frame", { compositionId: compId, time: 1 }, host);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("JOB_FAILED");
    expect(result.error?.message).toContain("no job runner");
  });
});
