import { describe, expect, it } from "vitest";
import { parseVideoProbe } from "./probe-video-parser";
import { buildSceneDetectionArgs, parseSceneDetectionTimes } from "./detect-scenes";
import { detectSceneChangesArgsSchema } from "../../shared/ipc-contract";

describe("ffprobe video stream truth", () => {
  it("retains NTSC rational, stream duration, sample aspect and display rotation", () => {
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001", duration: "12.5125", start_time: "0.161003", width: 1440, height: 1080, sample_aspect_ratio: "4:3", side_data_list: [{ rotation: -90 }] }], format: { duration: "13.0" } }))).toEqual({ fps: { num: 30000, den: 1001 }, durationSeconds: 12.5125, startTimeSeconds: 0.161003, width: 1440, height: 1080, sampleAspectRatio: { num: 4, den: 3 }, rotationDegrees: -90, variableFrameRate: false });
  });

  describe("FFmpeg scene detection", () => {
    it("uses a bounded scene threshold and parses unique candidate timestamps", () => {
      expect(buildSceneDetectionArgs("/video.mp4", 0.08)).toEqual([
        "-hide_banner",
        "-loglevel", "info",
        "-copyts",
        "-i", "/video.mp4",
        "-vf", "select='gt(scene,0.08)',showinfo",
        "-an",
        "-f", "null",
        "-",
      ]);
      expect(buildSceneDetectionArgs("/video.mp4", 0.08, {
        startTimeSeconds: 5.7,
        durationSeconds: 10,
      })).toEqual([
        "-hide_banner",
        "-loglevel", "info",
        "-copyts",
        "-ss", "5.7",
        "-i", "/video.mp4",
        "-to", "15.7",
        "-vf", "select='between(t,5.7,15.7)*gt(scene,0.08)',showinfo",
        "-an",
        "-f", "null",
        "-",
      ]);
      expect(parseSceneDetectionTimes([
        "[Parsed_showinfo_1] n: 0 pts_time:1.500",
        "[Parsed_showinfo_1] n: 1 pts_time:1.500",
        "[Parsed_showinfo_1] n: 2 pts_time:2.250",
        "[Parsed_showinfo_1] n: 3 pts_time:N/A",
      ].join("\n"))).toEqual([1.5, 2.25]);
    });

    it("requires complete time-window arguments over IPC", () => {
      expect(() => detectSceneChangesArgsSchema.parse({
        srcPath: "/video.mp4",
        startTimeSeconds: 2,
      })).toThrow(/requires both startTimeSeconds and durationSeconds/);
      expect(detectSceneChangesArgsSchema.parse({
        srcPath: "/video.mp4",
        startTimeSeconds: 2,
        durationSeconds: 4,
      })).toMatchObject({ srcPath: "/video.mp4", startTimeSeconds: 2, durationSeconds: 4 });
    });
  });
  it("does not turn an invalid or variable frame rate into a guessed clock", () => {
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "24000/1001", r_frame_rate: "30/1", width: 100, height: 100 }] })).fps).toBeNull();
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "0/0", r_frame_rate: "30/1", width: 100, height: 100 }] })).fps).toBeNull();
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "25/1", r_frame_rate: "25/1", duration: "N/A", width: 100, height: 100 }], format: { duration: "12.5" } })).durationSeconds).toBe(12.5);
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "25/1", r_frame_rate: "25/1", sample_aspect_ratio: "8:9", width: 720, height: 576 }] })).sampleAspectRatio).toEqual({ num: 8, den: 9 });
  });
});
