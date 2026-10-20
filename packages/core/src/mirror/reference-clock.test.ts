import { describe, expect, it } from "vitest";
import { probeReferenceClock, snapFrameRate } from "./reference-clock";

describe("snapFrameRate", () => {
  it("snaps whole rates to a reduced rational", () => {
    expect(snapFrameRate(30)).toEqual({ num: 30, den: 1 });
    expect(snapFrameRate(25)).toEqual({ num: 25, den: 1 });
    expect(snapFrameRate(60)).toEqual({ num: 60, den: 1 });
    expect(snapFrameRate(24)).toEqual({ num: 24, den: 1 });
  });

  it("snaps NTSC rates to their exact rationals", () => {
    expect(snapFrameRate(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(snapFrameRate(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(snapFrameRate(59.94)).toEqual({ num: 60000, den: 1001 });
  });

  it("keeps an unusual rate as an exact rational", () => {
    const snapped = snapFrameRate(33.3);
    expect(snapped).not.toBeNull();
    expect(snapped!.num / snapped!.den).toBeCloseTo(33.3, 3);
  });

  it("rejects an unusable measurement", () => {
    expect(snapFrameRate(0)).toBeNull();
    expect(snapFrameRate(-30)).toBeNull();
    expect(snapFrameRate(Number.NaN)).toBeNull();
    expect(snapFrameRate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("probeReferenceClock", () => {
  it("fails loudly when the file carries no video track", async () => {
    const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" });
    await expect(probeReferenceClock(file)).rejects.toThrow();
  });
});
