import { describe, expect, it } from "vitest";
import type { SegmentMap } from "@kove-advanced/creation-schema";
import {
  DIRECTOR_SYSTEM_PROMPT,
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

    // Hyphenated runtimes are real targets; interval phrases are not. The
    // corpus prompt that broke C3 verbatim: "Cut a 45-second YouTube Short …
    // hit roughly one point every 12-15 seconds" used to infer 15s.
    expect(
      inferTargetDuration(
        "Cut a 45-second YouTube Short from podcast #1.mp4 that teaches one clear idea. Hit roughly one point every 12-15 seconds.",
        "medium",
      ),
    ).toBe(45);
    // Even when the interval phrase comes first.
    expect(inferTargetDuration("Every 12-15 seconds, cut a 45-second clip", "fast")).toBe(45);
    // Offset phrases after the runtime must not win by being matched first.
    expect(
      inferTargetDuration("Make a 30-second TikTok. Start about 2 seconds before the punchline.", "fast"),
    ).toBe(30);

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

    expect(prompt).toContain("Signature effects (statements, not wallpaper):");
    // Every mirrored shader look is named, with its params.
    for (const name of ["vhs", "scanlines", "halftone", "dither", "posterize", "duotone", "gradient-map", "prism", "fisheye", "wave-warp", "edge-glow", "pixelate"]) {
      expect(prompt, name).toContain(`\`${name}\``);
    }
    expect(prompt).toContain("Params:");
    expect(prompt).toContain("never on consecutive shots");
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
    expect(prompt).toContain("Rendered transitions:");
    for (const name of ["crossZoom", "zoomBlur", "motionSmear", "strobeCut", "impactShake", "lumaWipe", "inkBleed", "tileFlip", "sliceSlide", "lightLeak", "vhsScan", "paperBurn", "pixelSort", "filmRoll"]) {
      expect(prompt, name).toContain(name);
    }
    // v2 flips the old restraint rule: transitions are REQUIRED punctuation.
    // (The baseline shipped 0 rendered transitions in 36/36 runs.)
    expect(prompt).toContain("a plan with ZERO rendered transitions is incomplete");
    expect(prompt).toContain("Hard cuts are the backbone");
    expect(prompt).toContain("never the same type twice in a row");
    expect(prompt).toContain("Put them in plan.transitions[]");
  });

  it("pins the v2 operating contract: plan-only, sequential layout, contract length", () => {
    const prompt = buildDirectorPrompt(segmentMap, "make a 30s tiktok edit", PRE_BAKED_GENRES[0]);

    // The phantom workflow is gone (audit contradiction 3): the director call
    // only ever receives submit_edit_plan, so it must never be told to execute.
    expect(prompt).toContain("You have ONE job: call submit_edit_plan");
    expect(prompt).toContain("Do NOT call editing tools");
    expect(prompt).not.toContain("IMMEDIATELY EXECUTE");
    expect(prompt).not.toContain("split_clip");

    // Placement and length are stated once, mechanically (C2/C3 enforce them).
    expect(prompt).toContain("targetPosition of each shot = targetPosition + duration of the previous shot");
    expect(prompt).toContain("Otherwise overlapping segments are a rejected plan");
    expect(prompt).toContain("MUST equal metadata.targetDuration (the target in the density contract), within 5%");
    expect(prompt).toContain("No gaps, no stacking");

    // Craft is signal-anchored, not counted.
    expect(prompt).toContain("No signal means no shot");
    expect(prompt).toContain("an accent with no trigger is banned");

    // C1: the param scales are the generated table, never hand-written prose.
    expect(prompt).toContain('- contrast: { "value": 0..2 x (default 1');
    expect(prompt).toContain('- brightness: { "value": -100..100 % (default 0');
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

  it("carves explicitly hard-cut requests out of the zero-transitions rule", () => {
    expect(DIRECTOR_SYSTEM_PROMPT).toContain("ZERO rendered transitions is incomplete");
    expect(DIRECTOR_SYSTEM_PROMPT).toContain(
      "unless the request explicitly asks for hard cuts only or no transitions",
    );
    expect(DIRECTOR_SYSTEM_PROMPT).toContain("the request wins");
  });
});
