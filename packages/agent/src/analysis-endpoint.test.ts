import { describe, expect, it } from "vitest";
import {
  isAnalysisAvailable,
  resolveAnalysisEndpoint,
  type AnalysisEnvironment,
} from "./registry";

/**
 * Where frame analysis is sent.
 *
 * The regression these tests exist for: the eco default used to be
 * `http://localhost:8000/analyze-frames` unconditionally, so a deployed app
 * asked every *visitor's* browser to analyze frames on the visitor's own
 * machine. Production builds must resolve that to null so the caller can fail
 * with an actionable message instead of a confusing network error.
 */

const LOCAL_ENGINE = "http://localhost:8000/analyze-frames";

function environment(
  values: Readonly<Record<string, string>> = {},
  isDev = false,
): AnalysisEnvironment {
  return { isDev, read: (key) => values[key] };
}

describe("resolveAnalysisEndpoint", () => {
  it("never sends a production build to localhost", () => {
    expect(resolveAnalysisEndpoint("eco", environment())).toBeNull();
  });

  it("uses the local engine in a dev build", () => {
    expect(resolveAnalysisEndpoint("eco", environment({}, true))).toBe(LOCAL_ENGINE);
  });

  it("prefers a deployed engine over the local one in a dev build", () => {
    const deployed = environment(
      { VITE_ECO_WORKER_URL: "https://engine.example/analyze-frames" },
      true,
    );
    expect(resolveAnalysisEndpoint("eco", deployed)).toBe(
      "https://engine.example/analyze-frames",
    );
  });

  it("uses a deployed engine in a production build", () => {
    const deployed = environment({
      VITE_ECO_WORKER_URL: "https://engine.example/analyze-frames",
    });
    expect(resolveAnalysisEndpoint("eco", deployed)).toBe(
      "https://engine.example/analyze-frames",
    );
  });

  it("prefers the server-side variable over the Vite one", () => {
    const both = environment({
      KOVE_ECO_WORKER_URL: "https://server.example/analyze-frames",
      VITE_ECO_WORKER_URL: "https://vite.example/analyze-frames",
    });
    expect(resolveAnalysisEndpoint("eco", both)).toBe(
      "https://server.example/analyze-frames",
    );
  });

  it("treats a blank value as unset", () => {
    const blank = environment({ VITE_ECO_WORKER_URL: "   " });
    expect(resolveAnalysisEndpoint("eco", blank)).toBeNull();
  });

  it("does not fall back to a local engine for ai mode", () => {
    expect(resolveAnalysisEndpoint("ai", environment({}, true))).toBeNull();
  });

  it("requires an explicit worker URL for ai mode", () => {
    const configured = environment({
      VITE_VISION_WORKER_URL: "https://vision.example/analyze-frames",
    });
    expect(resolveAnalysisEndpoint("ai", configured)).toBe(
      "https://vision.example/analyze-frames",
    );
  });

  it("keeps the two modes' configuration separate", () => {
    const ecoOnly = environment({ VITE_ECO_WORKER_URL: "https://engine.example" });
    expect(resolveAnalysisEndpoint("ai", ecoOnly)).toBeNull();
  });
});

describe("isAnalysisAvailable", () => {
  it("agrees with the resolver for the ambient environment", () => {
    for (const mode of ["eco", "ai"] as const) {
      expect(isAnalysisAvailable(mode)).toBe(resolveAnalysisEndpoint(mode) !== null);
    }
  });
});
