import { describe, expect, it } from "vitest";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { getTool, toAnthropicTools, toOpenAITools } from "./registry";
import { makeProjectWithClip } from "./test-fixtures";

/**
 * measure_export: tool wiring pinned end-to-end — registry handler →
 * host.measureExportFile → core QC pipeline. The ffmpeg layer itself is
 * covered in packages/core against recorded output; here the runner is
 * injected so no binary is needed.
 */

const EBUR128_STDERR = `
[Parsed_ebur128_0 @ 0x55e2c9a0] Summary:

  Integrated loudness:
    I:        -15.9 LUFS
    Threshold: -26.0 LUFS

  Loudness range:
    LRA:         3.2 dB

  True peak:
    Peak:        -1.4 dBFS
`;

const PROBE_STDOUT = JSON.stringify({ format: { duration: "60.050000" } });

function fixtureRunner(command: string, args: readonly string[]) {
  const joined = args.join(" ");
  if (joined.includes("ebur128")) {
    return Promise.resolve({ stdout: "", stderr: EBUR128_STDERR, exitCode: 0 });
  }
  if (command === "ffprobe") {
    return Promise.resolve({ stdout: PROBE_STDOUT, stderr: "", exitCode: 0 });
  }
  // blackdetect / silencedetect / freezedetect: clean pass, no events
  return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
}

describe("measure_export tool", () => {
  it("is registered and advertised to both LLM providers", () => {
    const tool = getTool("measure_export");
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
    expect(tool?.destructive).toBe(false);
    expect(toAnthropicTools().some((t) => t.name === "measure_export")).toBe(true);
    expect(
      toOpenAITools().some((t) => t.function.name === "measure_export"),
    ).toBe(true);
  });

  it("runs QC through an injected runner and returns verdicts", async () => {
    const host = new HeadlessHost(makeProjectWithClip(), {
      measureRunner: fixtureRunner,
    });
    const result = await executeTool(
      "measure_export",
      { path: "export.mp4", expectedDurationSec: 60 },
      host,
    );
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("I=-15.9 LUFS");
    expect(result.summary).toContain("TP=-1.4 dBTP");
    expect(result.summary).toContain("clean");

    const data = result.data as {
      loudness: { integrated: number; truePeak: number };
      drift: { driftSec: number };
      verdicts: {
        loudnessOk: boolean;
        truePeakOk: boolean;
        durationOk: boolean;
        clean: boolean;
      };
    };
    expect(data.loudness.integrated).toBeCloseTo(-15.9, 5);
    expect(data.loudness.truePeak).toBeCloseTo(-1.4, 5);
    expect(data.drift.driftSec).toBeCloseTo(0.05, 5);
    expect(data.verdicts).toEqual({
      loudnessOk: true,
      truePeakOk: true,
      durationOk: true,
      clean: true,
    });
  });

  it("reports OFF TARGET / CLIPPING verdicts for a hot export", async () => {
    const hot = EBUR128_STDERR.replace("I:        -15.9 LUFS", "I:        -11.0 LUFS").replace(
      "Peak:        -1.4 dBFS",
      "Peak:        4.5 dBFS",
    );
    const host = new HeadlessHost(makeProjectWithClip(), {
      measureRunner: (command, args) => {
        const joined = args.join(" ");
        if (joined.includes("ebur128")) {
          return Promise.resolve({ stdout: "", stderr: hot, exitCode: 0 });
        }
        if (command === "ffprobe") {
          return Promise.resolve({ stdout: PROBE_STDOUT, stderr: "", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const result = await executeTool(
      "measure_export",
      { path: "hot.mp4", expectedDurationSec: 60 },
      host,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("(OFF TARGET)");
    expect(result.summary).toContain("(CLIPPING)");
  });

  it("returns UNSUPPORTED_HOST on hosts without measureExportFile (one-line pin)", async () => {
    const bare = new HeadlessHost(makeProjectWithClip());
    // HeadlessHost always implements measureExportFile; simulate a host that doesn't.
    const withoutMeasure = { ...bare, measureExportFile: undefined } as unknown as typeof bare;
    const result = await executeTool("measure_export", { path: "x.mp4" }, withoutMeasure);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNSUPPORTED_HOST");
  });

  it("rejects a missing path", async () => {
    const host = new HeadlessHost(makeProjectWithClip(), {
      measureRunner: fixtureRunner,
    });
    const result = await executeTool("measure_export", {}, host);
    expect(result.ok).toBe(false);
  });
});
