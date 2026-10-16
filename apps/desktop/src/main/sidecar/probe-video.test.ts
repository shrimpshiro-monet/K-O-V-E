import { describe, expect, it } from "vitest";
import { parseVideoProbe } from "./probe-video-parser";

describe("ffprobe video stream truth", () => {
  it("retains NTSC rational, stream duration, sample aspect and display rotation", () => {
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001", duration: "12.5125", width: 1440, height: 1080, sample_aspect_ratio: "4:3", side_data_list: [{ rotation: -90 }] }], format: { duration: "13.0" } }))).toEqual({ fps: { num: 30000, den: 1001 }, durationSeconds: 12.5125, width: 1440, height: 1080, sampleAspectRatio: { num: 4, den: 3 }, rotationDegrees: -90, variableFrameRate: false });
  });
  it("does not turn an invalid or variable frame rate into a guessed clock", () => {
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "24000/1001", r_frame_rate: "30/1", width: 100, height: 100 }] })).fps).toBeNull();
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "0/0", r_frame_rate: "30/1", width: 100, height: 100 }] })).fps).toBeNull();
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "25/1", r_frame_rate: "25/1", duration: "N/A", width: 100, height: 100 }], format: { duration: "12.5" } })).durationSeconds).toBe(12.5);
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "25/1", r_frame_rate: "25/1", sample_aspect_ratio: "8:9", width: 720, height: 576 }] })).sampleAspectRatio).toEqual({ num: 8, den: 9 });
  });
});
