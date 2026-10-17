import { expect, it } from "vitest";
import { getTool } from "../../registry";
import { HeadlessHost } from "../../headless-host";
import { makeEmptyProject } from "../../test-fixtures";
import { fixture } from "./mirror-fixture";
it("registers mirror_reference_1to1 for the common tool router and compiles via its handler", async () => {
  const project = makeEmptyProject();
  project.mediaLibrary.items.push({ id: "m1", name: "source", type: "video", blob: null, fileHandle: null, thumbnailUrl: null, waveformData: null,
    metadata: { duration: 5, width: 1920, height: 1080, frameRate: 30, codec: "h264", sampleRate: 0, channels: 0, fileSize: 1 },
  });
  const tool = getTool("mirror_reference_1to1");
  expect(tool).toBeDefined();
  const host = new HeadlessHost(project);
  const result = await tool!.handler({ profile: fixture, userMediaIds: ["m1"] }, host);
  expect(result.ok).toBe(true);
  expect((result.data as { rhythmScore: number }).rhythmScore).toBe(1);
  expect(host.getProject().mirrorProfile?.shots).toHaveLength(2);
});
