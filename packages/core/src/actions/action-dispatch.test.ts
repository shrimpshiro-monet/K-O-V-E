import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";
import type { Project } from "../types/project";
import type { Action } from "../types/actions";

/**
 * Action dispatch integrity.
 *
 * `ActionExecutor` routes an action to one of ten per-domain switch statements
 * by its string prefix (`clip/…` → applyClipAction, `track/…` → applyTrackAction,
 * …). Two things can go wrong, and both fail *silently* in the app:
 *
 *   1. **A mis-dropped case.** `case "track/consolidate"` living inside
 *      applyClipAction never runs, because prefix routing sends `track/…`
 *      straight to applyTrackAction. The tool reports success; the timeline
 *      does not move. This actually shipped — the file scan below is the
 *      regression guard.
 *   2. **An unknown type falling through.** A switch with no `default:` accepts
 *      any string and returns success. The runtime tests below pin the loud
 *      refusal.
 */

const EXECUTOR_SOURCE = readFileSync(
  fileURLToPath(new URL("./action-executor.ts", import.meta.url)),
  "utf8",
).split("\n");

/** Domain inferred from the method name: applyTrackAction → "track". */
function domainOfMethod(method: string): string {
  return method.replace(/^apply/, "").replace(/Action$/, "").toLowerCase();
}

interface SwitchBlock {
  readonly method: string;
  readonly startLine: number;
  /** Set once the brace matcher finds the switch's closing brace. */
  readonly endLine?: number;
  readonly cases: Array<{ readonly full: string; readonly type: string; readonly line: number }>;
}

function collectSwitches(): SwitchBlock[] {
  const switches: SwitchBlock[] = [];

  let currentMethod: string | null = null;
  for (let index = 0; index < EXECUTOR_SOURCE.length; index += 1) {
    const line = EXECUTOR_SOURCE[index]!;
    const methodMatch = /^\s*private (?:async )?(\w+)\(/.exec(line);
    if (methodMatch) currentMethod = methodMatch[1]!;
    if (/^\s*switch \(/.test(line) && currentMethod) {
      switches.push({ method: currentMethod, startLine: index + 1, cases: [] });
    }
  }

  // Brace-count each switch body, then attribute every `case "<type>/…"` to the
  // switch that encloses it.
  const bodies = switches.map((entry) => {
    let depth = 0;
    let opened = false;
    for (let index = entry.startLine - 1; index < EXECUTOR_SOURCE.length; index += 1) {
      depth += (EXECUTOR_SOURCE[index]!.match(/{/g) ?? []).length;
      depth -= (EXECUTOR_SOURCE[index]!.match(/}/g) ?? []).length;
      if (EXECUTOR_SOURCE[index]!.includes("{")) opened = true;
      if (opened && depth === 0) {
        return { ...entry, endLine: index + 1 };
      }
    }
    throw new Error(`unbalanced switch for ${entry.method}`);
  });

  for (let index = 0; index < EXECUTOR_SOURCE.length; index += 1) {
    const caseMatch = /^\s*case "([a-z-]+\/[A-Za-z0-9-]+)"/.exec(EXECUTOR_SOURCE[index]!);
    if (!caseMatch) continue;
    const lineNumber = index + 1;
    const owner = bodies.find(
      (body) => lineNumber > body.startLine && lineNumber < body.endLine,
    );
    const full = caseMatch[1]!;
    owner?.cases.push({ full, type: full.split("/")[0]!, line: lineNumber });
  }

  return bodies;
}

function makeProject(): Project {
  return {
    id: "dispatch-project",
    name: "Dispatch",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

function makeProjectWithTrack(): Project {
  const project = makeProject();
  (project.timeline as { tracks: unknown[] }).tracks = [
    {
      id: "t1",
      type: "video",
      name: "V1",
      clips: [
        { id: "c1", mediaId: "m1", trackId: "t1", startTime: 0, duration: 2, inPoint: 0, outPoint: 2, effects: [], audioEffects: [], transform: {}, volume: 1, keyframes: [] },
        { id: "c2", mediaId: "m1", trackId: "t1", startTime: 5, duration: 2, inPoint: 2, outPoint: 4, effects: [], audioEffects: [], transform: {}, volume: 1, keyframes: [] },
      ],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    },
  ];
  return project;
}

const action = (type: string, params: Record<string, unknown> = {}): Action =>
  ({ type, id: `a-${type}`, timestamp: Date.now(), params }) as unknown as Action;

describe("action dispatch integrity", () => {
  it("keeps every case inside the switch for its own domain", () => {
    const misplaced: string[] = [];
    for (const block of collectSwitches()) {
      const expected = domainOfMethod(block.method);
      for (const entry of block.cases) {
        if (entry.type !== expected) {
          misplaced.push(
            `line ${entry.line}: case "${entry.type}/…" lives in ${block.method} (expected "${expected}")`,
          );
        }
      }
    }
    // Prefix routing can never reach a cross-domain case, so a mismatch here is
    // always dead code — and dead code in a dispatcher reads as a silent no-op.
    expect(misplaced).toEqual([]);
  });

  it("gives every domain switch a default that refuses unknown types", () => {
    const missing = collectSwitches()
      .filter((block) => {
        const body = EXECUTOR_SOURCE.slice(block.startLine - 1, block.endLine ?? block.startLine);
        return !body.some((line) => /^\s*default:/.test(line));
      })
      .map((block) => block.method);
    expect(missing).toEqual([]);
  });

  it("routes every declared case to a domain apply method", async () => {
    const executor = new ActionExecutor(new ActionHistory());
    const declared = new Set(
      collectSwitches().flatMap((block) => block.cases.map((entry) => entry.full)),
    );
    expect(declared.size).toBeGreaterThan(60);
    for (const type of declared) {
      // A declared case must not be rejected as unknown — validation errors for
      // missing params are fine, "Unknown … action type" is not.
      const result = await executor.execute(action(type), makeProject());
      const message = result.error?.message ?? "";
      expect(message, `${type} is not routed`).not.toMatch(/^Unknown .* action type/);
      expect(result.success || result.error !== undefined, `${type} returned nothing`).toBe(true);
    }
  });

  it("refuses an unknown action type and leaves the project untouched", async () => {
    const executor = new ActionExecutor(new ActionHistory());
    const project = makeProjectWithTrack();
    const before = JSON.stringify(project);

    for (const type of ["clip/addd", "track/consolidatte", "bogus/thing", "clip"]) {
      const result = await executor.execute(action(type), project);
      expect(result.success, type).toBe(false);
      expect(result.error?.message, type).toMatch(/^Unknown (.* action type|action type)/);
    }
    expect(JSON.stringify(project)).toBe(before);
  });

  it("actually consolidates a gapped track through the registered action type", async () => {
    const executor = new ActionExecutor(new ActionHistory());
    const project = makeProjectWithTrack();

    const result = await executor.execute(action("track/consolidate", { trackId: "t1" }), project);
    expect(result.success).toBe(true);

    const clips = (project.timeline.tracks[0] as { clips: Array<{ id: string; startTime: number }> })
      .clips;
    const byId = new Map(clips.map((clip) => [clip.id, clip.startTime]));
    // c1 stays at 0, c2 slides back to butt against it — the gap is gone.
    expect(byId.get("c1")).toBe(0);
    expect(byId.get("c2")).toBe(2);
  });

  it("refuses an invented type in every domain the router recognises", async () => {
    // The router dispatches by prefix; a domain whose target method lacked a
    // switch (transform/ was one) accepted any string and mutated the clip.
    const domains = [
      "project", "media", "track", "marker", "clip", "effect", "keyframe",
      "transform", "transition", "audio", "subtitle", "mask", "adjustment",
      "nested", "multicam", "creation", "motion", "text", "shape", "svg", "sticker",
    ];
    const executor = new ActionExecutor(new ActionHistory());

    const accepted: string[] = [];
    const threw: Array<{ domain: string; message: string }> = [];

    for (const domain of domains) {
      const project = makeProjectWithTrack();
      const before = JSON.stringify(project);
      try {
        const result = await executor.execute(
          action(`${domain}/zzzNotAThing`, { clipId: "c1" }),
          project,
        );
        if (result.success || JSON.stringify(project) !== before) {
          accepted.push(domain);
        }
      } catch (error) {
        threw.push({ domain, message: (error as Error).message });
      }
    }

    expect(accepted).toEqual([]);
    expect(threw).toEqual([]);
  });
});
