import { describe, expect, it } from "vitest";
import type { SegmentMap } from "@kove-advanced/creation-schema";
import {
  buildDensityContract,
  buildDirectorPrompt,
  buildExpansionPrompt,
  formatDensityContract,
  inferTargetDuration,
  resolveDirectorVideoId,
} from "./director-prompt";
import { PRE_BAKED_GENRES } from "./genres";

const segmentMap: SegmentMap = {
  videos: [
    {
      videoId: "85bb4b60-8218-455d-999a-616e9d553716",
      duration: 12,
      segments: [],
    },
  ],
};

describe("director prompt", () => {
  it("resolves model video aliases to the imported media ID", () => {
    expect(resolveDirectorVideoId(segmentMap, "video_0")).toBe(
      "85bb4b60-8218-455d-999a-616e9d553716",
    );
    expect(resolveDirectorVideoId(segmentMap, "clip-0")).toBe(
      "85bb4b60-8218-455d-999a-616e9d553716",
    );
  });

  it("does not throw when a worker result has no segments array", () => {
    const partialMap = {
      videos: [{ videoId: "video-id", duration: 12 }],
    } as unknown as SegmentMap;

    expect(() => buildDirectorPrompt(partialMap, "make a short highlight")).not.toThrow();
    expect(buildDirectorPrompt(partialMap, "make a short highlight")).toContain(
      "video_0: video-id",
    );
  });

  it("includes a measurable style target for a selected genre", () => {
    const prompt = buildDirectorPrompt(
      segmentMap,
      "make a highlight",
      PRE_BAKED_GENRES[0],
    );

    expect(prompt).toContain('"styleProfile"');
    expect(prompt).toContain('"cutsPerMinute"');
    expect(prompt).toContain('"cutStyle": "hard"');
  });

  it("sizes the density contract from the prompt and the genre", () => {
    expect(inferTargetDuration("make a 30s tiktok edit", "fast")).toBe(30);
    expect(inferTargetDuration("give me about 2 minutes", "slow")).toBe(120);
    expect(inferTargetDuration("just make something cool", "fast")).toBe(30);

    const contract = buildDensityContract("30 second tiktok edit", PRE_BAKED_GENRES[0]);
    expect(contract.targetDuration).toBe(30);
    expect(contract.shots[0]).toBeGreaterThanOrEqual(12);
    expect(contract.cameraMoves).toBeGreaterThan(5);
    expect(contract.effectHits[0]).toBeGreaterThan(0);
    expect(contract.texts[1]).toBeGreaterThanOrEqual(contract.texts[0]);

    const rendered = formatDensityContract(contract);
    expect(rendered).toContain("Shots");
    expect(rendered).toContain("Camera moves");
    expect(rendered).toContain("Evolution");
  });

  it("injects the density contract, camera vocabulary and text presets into the task prompt", () => {
    const prompt = buildDirectorPrompt(segmentMap, "make a 30s tiktok edit", PRE_BAKED_GENRES[0]);
    expect(prompt).toContain("## Edit density contract (MANDATORY for this request)");
    expect(prompt).toContain("Shots");
    expect(prompt).toContain("slow-push");
    expect(prompt).toContain("snap-zoom");
    expect(prompt).toContain("cameraMoves");
    expect(prompt).toContain("zoom-blur");
    // No unresolved template tokens may ship to the model.
    expect(prompt).not.toContain("{MOVE_ATLAS}");
    expect(prompt).not.toContain("{none,");
  });

  it("advertises the signature-effect vocabulary and the genre's suggested looks", () => {
    const genre = PRE_BAKED_GENRES.find((g) => g.id === "meme-compilation")!;
    const prompt = buildDirectorPrompt(segmentMap, "make a 20s meme edit", genre);

    expect(prompt).toContain("## Signature effects (custom looks — deliberate, never wallpaper)");
    // Every mirrored shader look is named, with its params.
    for (const name of ["vhs", "scanlines", "halftone", "dither", "posterize", "duotone", "gradient-map", "prism", "fisheye", "wave-warp", "edge-glow", "pixelate"]) {
      expect(prompt, name).toContain(`\`${name}\``);
    }
    expect(prompt).toContain("Params:");
    expect(prompt).toContain("never the same look on consecutive shots");
    // The genre's own suggestion rides along, scoped to moments.
    expect(prompt).toContain("Signature looks this genre reaches for: posterize, dither, halftone");
    expect(prompt).toContain("never on every shot");
  });

  it("lets the expansion brief name real signature effects instead of vague 'cool effects'", () => {
    const expansion = buildExpansionPrompt("make something cool", segmentMap, PRE_BAKED_GENRES[0]);
    expect(expansion).toContain("## Effects you may name in the brief");
    expect(expansion).toContain("Signature shader effects (exact names):");
    expect(expansion).toContain("vhs");
    expect(expansion).toContain("halftone");
    expect(expansion).toContain("Mention at most 1-3 of these");
  });

  it("advertises the full transition vocabulary with craft guidance", () => {
    const prompt = buildDirectorPrompt(segmentMap, "make a 30s tiktok edit", PRE_BAKED_GENRES[0]);
    expect(prompt).toContain("The full vocabulary:");
    for (const name of ["crossZoom", "zoomBlur", "motionSmear", "strobeCut", "impactShake", "lumaWipe", "inkBleed", "tileFlip", "sliceSlide", "lightLeak", "vhsScan", "paperBurn", "pixelSort", "filmRoll"]) {
      expect(prompt, name).toContain(name);
    }
    expect(prompt).toContain("Most junctions should stay hard cuts");
    expect(prompt).toContain("never the same one twice in a row");
  });

  it("passes analyzed segment signals into the director prompt", () => {
    const prompt = buildDirectorPrompt({
      videos: [{
        videoId: "video-1",
        duration: 12,
        segments: [{
          id: "segment-1",
          startTime: 2,
          endTime: 4,
          description: "high-energy action",
          sceneType: "action",
          motionLevel: "high",
          hasDialogue: false,
          visualContent: "player drives to the basket",
          confidence: 0.92,
          motionPeak: 0.88,
          audioEnergy: 0.76,
          beatTimestamps: [2.1, 2.6],
          facePresenceRatio: 0.5,
          importanceScore: 0.94,
        }],
      }],
    }, "make the strongest highlight");

    expect(prompt).toContain("## Footage Analysis");
    expect(prompt).toContain("importance=0.94");
    expect(prompt).toContain("beats=[2.1,2.6]");
    expect(prompt).toContain("segment-1");
    expect(prompt).toContain("high-energy action");
  });

  it("lists audio/video media library entries with their exact ids", () => {
    const prompt = buildDirectorPrompt(segmentMap, "make a montage", undefined, undefined, [
      { id: "media_mus1", name: "bed.mp3", type: "audio", duration: 30 },
      { id: "media_vid1", name: "footage.mp4", type: "video", duration: 8 },
      { id: "media_img1", name: "cover.png", type: "image", duration: 0 },
    ]);

    expect(prompt).toContain("## Available media library");
    expect(prompt).toContain('- media_0: media_mus1 — "bed.mp3" (audio, 30.0s)');
    expect(prompt).toContain('- media_1: media_vid1 — "footage.mp4" (video, 8.0s)');
    // Images cannot carry music/sfx — keep them out of the id list.
    expect(prompt).not.toContain("cover.png");
    expect(prompt).toContain("use EXACTLY one of the media ids below");
    expect(prompt).toContain(
      '"sourceVideoId": "<media id from the Available media library block>"',
    );
  });

  it("omits the media library block when no library is available", () => {
    expect(buildDirectorPrompt(segmentMap, "make a montage")).not.toContain(
      "## Available media library",
    );
    expect(
      buildDirectorPrompt(segmentMap, "make a montage", undefined, undefined, []),
    ).not.toContain("## Available media library");
  });

  it("carries the density contract and the media catalog in the same prompt", () => {
    // The two prompt rewrites landed on different branches; both must survive.
    const prompt = buildDirectorPrompt(
      segmentMap,
      "make a 30s tiktok edit",
      PRE_BAKED_GENRES[0],
      undefined,
      [{ id: "media_mus1", name: "bed.mp3", type: "audio", duration: 30 }],
    );

    expect(prompt).toContain("## Edit density contract (MANDATORY for this request)");
    expect(prompt).toContain("## Signature effects (custom looks — deliberate, never wallpaper)");
    expect(prompt).toContain("## Available media library");
    expect(prompt).toContain("cameraMoves");
    // audioDecisions must point at the inlined catalog, not the list_media tool
    // the nested plan_edit call cannot reach.
    expect(prompt).toContain(
      '"sourceVideoId": "<media id from the Available media library block>"',
    );
    expect(prompt).not.toContain('"sourceVideoId": "<media id from list_media>"');
  });
});
