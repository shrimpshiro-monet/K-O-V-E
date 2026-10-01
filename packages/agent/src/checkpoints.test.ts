import { describe, it, expect } from "vitest";
import { fingerprintProject } from "./checkpoints";

describe("fingerprintProject", () => {
  it("ignores key order, modifiedAt, undefined and empty arrays", () => {
    const a = { id: "p", modifiedAt: 1, tracks: [{ id: "t", clips: [] }], x: { b: 1, a: 2 } };
    const b = { x: { a: 2, b: 1 }, tracks: [{ clips: [], id: "t", extra: undefined }], modifiedAt: 999, id: "p", textClips: [] };
    const c = { x: { a: 2, b: 1 }, tracks: [{ id: "t" }], id: "p" };
    expect(fingerprintProject(a)).toBe(fingerprintProject(b));
    expect(fingerprintProject(a)).toBe(fingerprintProject(c));
  });

  it("changes on real content changes", () => {
    const base = { id: "p", tracks: [{ id: "t", muted: false }] };
    const fp = fingerprintProject(base);
    expect(fingerprintProject({ ...base, id: "q" })).not.toBe(fp);
    expect(fingerprintProject({ ...base, tracks: [{ id: "t", muted: true }] })).not.toBe(fp);
    expect(fingerprintProject({ ...base, tracks: [{ id: "t", muted: false }, { id: "u" }] })).not.toBe(fp);
    expect(fingerprintProject({ id: "p", tracks: [{ id: "t", muted: 0 }] })).not.toBe(fp);
  });

  it("handles cycles and typed arrays without throwing", () => {
    const o: Record<string, unknown> = { id: 1, wave: new Float32Array(4) };
    o.self = o;
    expect(() => fingerprintProject(o)).not.toThrow();
  });
});
