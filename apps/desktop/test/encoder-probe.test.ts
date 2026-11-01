import { describe, it, expect, vi } from "vitest";
import { parseEncoders, selectEncoder, selectUsableEncoder } from "../src/main/sidecar/encoder-probe";

const SAMPLE = `
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder
 V....D hevc_videotoolbox    VideoToolbox HEVC Encoder
 V....D libx264              libx264 H.264
 V....D prores_videotoolbox  Apple ProRes
`;

describe("encoder probe", () => {
  it("parses encoder names from ffmpeg -encoders output", () => {
    const names = parseEncoders(SAMPLE);
    expect(names).toContain("h264_videotoolbox");
    expect(names).toContain("libx264");
  });

  it("selects videotoolbox h264 on darwin when present", () => {
    const names = parseEncoders(SAMPLE);
    expect(selectEncoder("h264", "darwin", names)).toBe("h264_videotoolbox");
  });

  it("falls back to libx264 when no hw encoder present", () => {
    expect(selectEncoder("h264", "linux", ["libx264"])).toBe("libx264");
  });

  it("selects prores_videotoolbox for prores on darwin", () => {
    const names = parseEncoders(SAMPLE);
    expect(selectEncoder("prores", "darwin", names)).toBe("prores_videotoolbox");
  });

  it("selects the requested VP8/VP9 encoder rather than silently using H.264", () => {
    expect(selectEncoder("vp9", "linux", ["libx264", "libvpx-vp9"])).toBe("libvpx-vp9");
    expect(selectEncoder("vp8", "linux", ["libx264", "libvpx"])).toBe("libvpx");
    expect(selectEncoder("vp9", "linux", ["libx264"])).toBeNull();
  });
});

describe("selectEncoder mode-awareness", () => {
  const hw = ["h264_videotoolbox", "hevc_videotoolbox", "libx264", "libx265", "libsvtav1"];

  it("prefers hardware for fast/balanced", () => {
    expect(selectEncoder("h265", "darwin", hw, "balanced")).toBe("hevc_videotoolbox");
    expect(selectEncoder("h264", "darwin", hw, "fast")).toBe("h264_videotoolbox");
  });

  it("forces software for smallest", () => {
    expect(selectEncoder("h265", "darwin", hw, "smallest")).toBe("libx265");
    expect(selectEncoder("av1", "darwin", hw, "smallest")).toBe("libsvtav1");
  });

  it("falls back to software when hardware is missing", () => {
    const swOnly = ["libx264", "libx265", "libsvtav1"];
    expect(selectEncoder("h265", "darwin", swOnly, "balanced")).toBe("libx265");
  });
});

describe("hardware encoder usability", () => {
  it("falls back to the same software codec when advertised drivers cannot encode", async () => {
    const probe = vi.fn(async () => false);
    const available = ["h264_nvenc", "h264_vaapi", "libx264"];
    expect(await selectUsableEncoder("h264", "linux", available, "balanced", probe)).toBe("libx264");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith("h264_nvenc", "h264", "balanced");
    expect(probe).toHaveBeenCalledWith("h264_vaapi", "h264", "balanced");
  });

  it("preserves hardware preference among the candidates that can encode", async () => {
    const probe = vi.fn(async (encoder: string) => encoder === "h264_vaapi");
    expect(await selectUsableEncoder("h264", "linux", ["h264_nvenc", "h264_vaapi", "libx264"], "fast", probe)).toBe("h264_vaapi");
  });

  it("returns no encoder rather than an unusable hardware driver when no fallback exists", async () => {
    const probe = vi.fn(async () => { throw new Error("device lost"); });
    expect(await selectUsableEncoder("h264", "linux", ["h264_nvenc"], "balanced", probe)).toBeNull();
  });

  it("does not probe hardware when smallest mode already selects software", async () => {
    const probe = vi.fn(async () => true);
    expect(await selectUsableEncoder("h265", "darwin", ["hevc_videotoolbox", "libx265"], "smallest", probe)).toBe("libx265");
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps the ProRes software encoder when VideoToolbox is unavailable", async () => {
    expect(await selectUsableEncoder("prores", "darwin", ["prores_videotoolbox", "prores_ks"], "balanced", async () => false)).toBe("prores_ks");
  });
});
