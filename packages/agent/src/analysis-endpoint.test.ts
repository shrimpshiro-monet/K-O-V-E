import { describe, expect, it } from "vitest";
import {
  isAnalysisAvailable,
  resolveAnalysisEndpoint,
  resolveAnalysisToken,
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

/**
 * The token a hardened backend demands.
 *
 * Both backends refuse tokenless requests once one is configured — the worker
 * answers 503 until `WORKER_AUTH_TOKEN` exists, the engine answers 401 once
 * `KOVE_ENGINE_TOKEN` is set. Without a value reaching the request, locking a
 * backend down silently breaks every analysis call, so the client has to be able
 * to carry one.
 */
describe("resolveAnalysisToken", () => {
  it("is null when nothing is configured (backends that are not locked down)", () => {
    expect(resolveAnalysisToken("eco", environment())).toBeNull();
    expect(resolveAnalysisToken("ai", environment())).toBeNull();
  });

  it("reads the Vite variables the app ships with", () => {
    expect(
      resolveAnalysisToken(
        "eco",
        environment({ VITE_ECO_WORKER_TOKEN: "engine-token" }),
      ),
    ).toBe("engine-token");
    expect(
      resolveAnalysisToken(
        "ai",
        environment({ VITE_VISION_WORKER_TOKEN: "worker-token" }),
      ),
    ).toBe("worker-token");
  });

  it("prefers the server-side variable over the Vite one", () => {
    const both = environment({
      KOVE_VISION_WORKER_TOKEN: "server-token",
      VITE_VISION_WORKER_TOKEN: "vite-token",
    });
    expect(resolveAnalysisToken("ai", both)).toBe("server-token");
  });

  it("treats a blank value as unset", () => {
    const blank = environment({ VITE_ECO_WORKER_TOKEN: "   " });
    expect(resolveAnalysisToken("eco", blank)).toBeNull();
  });

  it("keeps the two backends' tokens separate", () => {
    const ecoOnly = environment({ VITE_ECO_WORKER_TOKEN: "engine-token" });
    expect(resolveAnalysisToken("ai", ecoOnly)).toBeNull();
  });

  it("does not confuse a worker token for an engine token", () => {
    const aiOnly = environment({ VITE_VISION_WORKER_TOKEN: "worker-token" });
    expect(resolveAnalysisToken("eco", aiOnly)).toBeNull();
  });
});

describe("isAnalysisAvailable", () => {
  it("agrees with the resolver for the ambient environment", () => {
    for (const mode of ["eco", "ai"] as const) {
      expect(isAnalysisAvailable(mode)).toBe(resolveAnalysisEndpoint(mode) !== null);
    }
  });
});
