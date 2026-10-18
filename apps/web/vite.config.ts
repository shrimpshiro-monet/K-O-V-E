import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import { stripFfmpegPlugin } from "./vite-plugins/strip-ffmpeg";
import { pruneFontsPlugin } from "./vite-plugins/prune-fonts";
import {
  devAuthConfigured,
  handleDevLlmRequest,
  type DevLlmGatewayEnv,
} from "./dev-llm-gateway";

const isDesktop = process.env.KOVE_ADVANCED_DESKTOP === "1";

/**
 * Reads server-side secrets from .dev.vars for the DEV-ONLY /api/llm gateway.
 * Values are used by the Node dev server process only — they are NEVER
 * injected as VITE_* env vars, so no provider secret can reach the client
 * bundle in dev.
 *
 * Keys read:
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — Workers AI credentials
 *   CLERK_ISSUER (+ CLERK_JWKS_URL / CLERK_AUDIENCE) — session auth. When
 *   CLERK_ISSUER is present the dev server enforces the FULL gateway
 *   (auth/quota/metering, in-memory ledger); when absent it falls back to
 *   the legacy credential-injecting passthrough (local dev convenience).
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — tier/ledger (optional in dev;
 *   without them the tier resolves to free, fail-closed).
 *   FRONTIER_BASE_URL / FRONTIER_API_KEY — optional Pro frontier slot.
 */
function readDevLlmEnv(): DevLlmGatewayEnv {
  const devVarsPath = path.resolve(__dirname, "../../.dev.vars");
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  if (fs.existsSync(devVarsPath)) {
    const content = fs.readFileSync(devVarsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (!env[key]) env[key] = val;
    }
  }
  const pick = (k: string): string | undefined => env[k]?.trim() || undefined;
  return {
    CLOUDFLARE_API_TOKEN: pick("CLOUDFLARE_API_TOKEN"),
    CLOUDFLARE_ACCOUNT_ID: pick("CLOUDFLARE_ACCOUNT_ID"),
    CLERK_ISSUER: pick("CLERK_ISSUER"),
    CLERK_JWKS_URL: pick("CLERK_JWKS_URL"),
    CLERK_AUDIENCE: pick("CLERK_AUDIENCE"),
    SUPABASE_URL: pick("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: pick("SUPABASE_SERVICE_ROLE_KEY"),
    FRONTIER_BASE_URL: pick("FRONTIER_BASE_URL"),
    FRONTIER_API_KEY: pick("FRONTIER_API_KEY"),
    GATEWAY_FAST_MODEL: pick("GATEWAY_FAST_MODEL"),
    GATEWAY_FRONTIER_MODEL: pick("GATEWAY_FRONTIER_MODEL"),
  };
}

/**
 * Mounts the authenticated /api/llm gateway on the Vite dev server.
 * Returns the middleware (so `configureServer` can attach it) — used only
 * when CLERK_ISSUER is configured; otherwise the plain proxy remains.
 */
function makeDevLlmMiddleware(devEnv: DevLlmGatewayEnv): Connect.NextHandleFunction {
  return (req, res, next) => {
    void (async () => {
      try {
        // Buffer the request body (dev cap: same 8 MB as prod — enforced
        // again inside handleLlmGateway). 'data' chunks can arrive as
        // Buffer/Uint8Array/ArrayBuffer depending on the Node version.
        const raw = await new Promise<Buffer>((resolve, reject) => {
          // Already drained (e.g. GET with no body) — resolve immediately.
          if (req.readableEnded || req.complete) {
            resolve(Buffer.alloc(0));
            return;
          }
          const chunks: Uint8Array[] = [];
          req.on("data", (chunk: unknown) => {
            chunks.push(
              chunk instanceof ArrayBuffer
                ? new Uint8Array(chunk)
                : (chunk as Uint8Array),
            );
          });
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
        });

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) if (typeof v === "string") headers.append(key, v);
          } else if (value != null) {
            headers.set(key, String(value));
          }
        }

        const fullUrl = new URL(req.originalUrl ?? req.url ?? "/", "http://localhost");
        const subPath = fullUrl.pathname.replace(/^\/api\/llm\/?/, "");
        const request = new Request(fullUrl, {
          method: req.method ?? "GET",
          headers,
          body:
            (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && raw.length
              ? raw
              : undefined,
        });

        const response = await handleDevLlmRequest(request, devEnv, subPath);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          if (key === "connection" || key === "content-length") return;
          res.setHeader(key, value);
        });
        // res.end() accepts string/Buffer/Uint8Array — NOT ArrayBuffer.
        const body = Buffer.from(await response.arrayBuffer());
        res.end(body);
      } catch (err) {
        // The middleware must never take the dev server down.
        console.warn("[vite] /api/llm dev middleware error:", err);
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "INTERNAL", message: "Dev gateway error" } }));
        } else {
          res.end();
        }
      }
    })();
    void next; // never falls through — the gateway fully owns /api/llm
  };
}

// Read once at config-load time so the proxy decision and the middleware
// agree (both derive from the same dev vars).
const devLlmEnv = readDevLlmEnv();

/**
 * §2 dev middleware, registered as a Vite PLUGIN (a plugin's configureServer
 * hook runs before vite's internal middlewares — including the proxy — so the
 * gateway owns /api/llm when dev auth is configured). Note: `server.`
 * configureServer is NOT a user option in Vite 5; only plugin hooks run.
 */
function devLlmGatewayPlugin(): Plugin {
  return {
    name: "kove-advanced:dev-llm-gateway",
    apply: "serve",
    configureServer(server) {
      if (!devAuthConfigured(devLlmEnv)) {
        console.log(
          "[vite] /api/llm dev: LEGACY passthrough (no CLERK_ISSUER in .dev.vars — " +
            "auth NOT enforced; local development only).",
        );
        return;
      }
      server.middlewares.use("/api/llm", makeDevLlmMiddleware(devLlmEnv));
      console.log(
        "[vite] /api/llm dev: FULL gateway active (Clerk auth, quota, metering; in-memory ledger). " +
          "Set CLERK_ISSUER + CLOUDFLARE_* in .dev.vars. Passthrough proxy disabled.",
      );
    },
  };
}

function desktopHtmlPlugin() {
  return {
    name: "kove-advanced-desktop-html",
    transformIndexHtml(html: string) {
      if (!isDesktop) return html;
      let out = html
        .replace(/href="\/favicon\.svg"/g, 'href="./favicon.svg"')
        .replace(/href="\/manifest\.json"/g, 'href="./manifest.json"')
        .replace(/href="\/icons\/icon-192\.png"/g, 'href="./icons/icon-192.png"');
      out = out.replace(
        /<link rel="preconnect"[^>]*>\s*/g,
        "",
      );
      out = out.replace(
        /<link href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g,
        '<link href="./fonts/google-fonts.css" rel="stylesheet" />',
      );
      return out;
    },
  };
}

export default defineConfig({
  base: isDesktop ? "./" : "/",
  plugins: [react(), devLlmGatewayPlugin(), desktopHtmlPlugin(), stripFfmpegPlugin(isDesktop), pruneFontsPlugin(isDesktop)],
  assetsInclude: ["**/*.wasm"],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "@": path.resolve(__dirname, "./src"),
      "@kove-advanced/core": path.resolve(__dirname, "../../packages/core/src"),
      "@kove-advanced/agent": path.resolve(__dirname, "../../packages/agent/src"),
      "@kove-advanced/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@ffmpeg/core", "@ffmpeg/core-mt"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react";
          if (id.includes("node_modules/zustand")) return "zustand";
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("node_modules/@radix-ui")) return "radix";
        },
      },
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    // Local sandboxed preview environments reach the dev server through a
    // proxy host; enable only when explicitly requested.
    allowedHosts: process.env.KOVE_DEV_ALLOW_ALL_HOSTS ? true : undefined,
    // §2: when CLERK_ISSUER is configured in .dev.vars, /api/llm is served by
    // the FULL authenticated gateway (devLlmGatewayPlugin below) and the
    // legacy passthrough proxy is NOT registered — so dev can never be an
    // unauthenticated LLM hole. Without CLERK_ISSUER the legacy
    // credential-injecting proxy is used (local-dev convenience, loud warning).
    proxy: (() => {
      if (devAuthConfigured(devLlmEnv)) return {};
      // EXPLICIT server-side LLM gateway for dev: the client calls
      // same-origin /api/llm/* and this proxy (Node dev-server process, never
      // the browser) attaches the Cloudflare credentials read from the
      // environment or .dev.vars. Mirrors apps/web/functions/api/llm in prod.
      const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = devLlmEnv;
      console.log(
        "[vite] /api/llm dev proxy:",
        apiToken && accountId
          ? "credentials loaded (server-side only)"
          : "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing — LLM calls will 401",
      );
      return {
        "/api/llm": {
          target: "https://api.cloudflare.com",
          changeOrigin: true,
          rewrite: (p: string) =>
            p.replace(/^\/api\/llm/, `/client/v4/accounts/${accountId}/ai`),
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
          timeout: 120000,
          proxyTimeout: 120000,
        },
      };
    })(),
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
