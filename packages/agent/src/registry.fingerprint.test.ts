import { describe, expect, it } from "vitest";
import type { EditPlan } from "@kove-advanced/creation-schema";
import { computeEditPlanFingerprint } from "./registry";

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends object ? DeepMutable<T[K]> : T[K];
};

/** Deep mutable clone — typed against known fields so renames are caught by the compiler. */
function mut(base: EditPlan): DeepMutable<EditPlan> {
  return structuredClone(base) as DeepMutable<EditPlan>;
}

function makeMinimalPlan(): EditPlan {
  return {
    segments: [
      {
        sourceVideoId: "v1",
        sourceStartTime: 0,
        sourceEndTime: 10,
        trackIndex: 0,
        targetPosition: 0,
        effects: [],
        effectSpecs: [{ type: "brightness", params: { value: 50 }, intensity: 0.5, rationale: "brighten" }],
        rationale: "clip 1",
      },
    ],
    textElements: [
      {
        content: "Hello",
        style: "title",
        startTime: 0,
        duration: 3,
        fontSize: 48,
        fontFamily: "Arial",
        color: "#fff",
        position: { x: 0.5, y: 0.5 },
        animation: "fade-in",
        animationInSec: 0.3,
        animationOutSec: 0.2,
        rationale: "title text",
      },
    ],
    effects: [{ type: "saturation", params: { value: 80 }, targetSegmentIndex: 0, rationale: "boost" }],
    transitions: [{ afterSegmentIndex: 0, type: "crossfade", duration: 0.5, rationale: "fade" }],
    audioDecisions: [{ type: "music", startTime: 0, duration: 10, volume: 0.8, rationale: "bgm" }],
    captionTemplate: { fontSize: 36, color: "#ffffff", fontFamily: "Helvetica", position: { x: 0.5, y: 0.86 }, align: "center" },
    motionMoments: [{ move: "3d-title-card", segmentIndex: 0, atTime: 0, duration: 2, insertIntoEditor: true, rationale: "motion" }],
    metadata: { targetDuration: 10, targetPlatform: "youtube", genre: "vlog", pacing: "medium", rationale: "meta" },
  } satisfies EditPlan;
}

describe("plan fingerprint", () => {
  it("changes when any material field changes", () => {
    const base = makeMinimalPlan();
    const baseHash = computeEditPlanFingerprint(base);

    const fp = (r: EditPlan) => computeEditPlanFingerprint(r);

    // metadata.targetDuration
    const a = mut(base);
    a.metadata.targetDuration = 999;
    expect(fp(a)).not.toBe(baseHash);

    // metadata.genre
    const b = mut(base);
    b.metadata.genre = "documentary";
    expect(fp(b)).not.toBe(baseHash);

    // captionTemplate.fontSize
    const c = mut(base);
    (c.captionTemplate as { fontSize: number }).fontSize = 99;
    expect(fp(c)).not.toBe(baseHash);

    // textElement.fontSize
    const d = mut(base);
    d.textElements[0].fontSize = 99;
    expect(fp(d)).not.toBe(baseHash);

    // textElement.style
    const e = mut(base);
    e.textElements[0].style = "lower-third";
    expect(fp(e)).not.toBe(baseHash);

    // motionMoments
    const f = mut(base);
    f.motionMoments = [{ move: "glitch-transition" }];
    expect(fp(f)).not.toBe(baseHash);

    // effects[0].startOffset — future field, must bypass type
    const g = mut(base);
    (g.effects[0] as unknown as Record<string, unknown>).startOffset = 9;
    expect(fp(g as unknown as EditPlan)).not.toBe(baseHash);

    // segments[0].speed — known optional field, typed
    const h = mut(base);
    h.segments[0].speed = 2.0;
    expect(fp(h)).not.toBe(baseHash);

    // segments[0].speedRamp — known optional field, typed
    const i = mut(base);
    i.segments[0].speedRamp = { keyframes: [{ time: 0, speed: 2 }] };
    expect(fp(i)).not.toBe(baseHash);

    // segments[0].layout — known optional field, typed
    const j = mut(base);
    j.segments[0].layout = { region: "pip-corner" };
    expect(fp(j)).not.toBe(baseHash);

    // audioDecisions[0].volume — future field, must bypass type
    const k = mut(base);
    (k.audioDecisions[0] as unknown as Record<string, unknown>).volume = 0.1;
    expect(fp(k as unknown as EditPlan)).not.toBe(baseHash);

    // transitions[0].duration — future field, must bypass type
    const l = mut(base);
    (l.transitions[0] as unknown as Record<string, unknown>).duration = 2.0;
    expect(fp(l as unknown as EditPlan)).not.toBe(baseHash);

    // segments[0].effects — known field, typed
    const m = mut(base);
    m.segments[0].effects = ["colorGrade"];
    expect(fp(m)).not.toBe(baseHash);
  });

  it("does not change when only rationale changes", () => {
    const base = makeMinimalPlan();
    const copy = mut(base);
    copy.segments[0].rationale = "completely different";
    copy.metadata.rationale = "also different";
    copy.effects[0].rationale = "still different";
    expect(computeEditPlanFingerprint(copy)).toBe(computeEditPlanFingerprint(base));
  });

  it("is insensitive to object key order", () => {
    const base = makeMinimalPlan();
    const copy = mut(base);
    copy.textElements[0].position = { y: 0.5, x: 0.5 };
    expect(computeEditPlanFingerprint(copy)).toBe(computeEditPlanFingerprint(base));
  });

  it("hashes fields not in the original enumeration (future-proofing)", () => {
    const base = makeMinimalPlan();
    const baseHash = computeEditPlanFingerprint(base);

    // Add a top-level property that is NOT one of the EditPlan fields.
    // If the fingerprint uses an explicit field list, this won't be hashed
    // and the hash won't change — that's the bug.
    const withFutureField = { ...base, futureOverlay: { some: "new" } } as unknown as EditPlan;
    expect(computeEditPlanFingerprint(withFutureField)).not.toBe(baseHash);
  });

  it("hashes unknown nested fields (recursive stripRationale)", () => {
    const base = makeMinimalPlan();
    const baseHash = computeEditPlanFingerprint(base);

    // Add a property to a nested object. stripRationale must recurse and
    // include it — if the fingerprint only hashes known segment fields,
    // this won't change the hash.
    const withNested = mut(base);
    (withNested.segments[0] as unknown as Record<string, unknown>).futureSegmentField = "x";
    expect(computeEditPlanFingerprint(withNested as unknown as EditPlan)).not.toBe(baseHash);
  });
});
