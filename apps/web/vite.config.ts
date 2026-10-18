import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import { stripFfmpegPlugin } from "./vite-plugins/strip-ffmpeg";
import { pruneFontsPlugin } from "./vite-plugins/prune-fonts";

const isDesktop = process.env.KOVE_ADVANCED_DESKTOP === "1";

/**
 * Reads CLOUDFLARE_* values from .dev.vars for the DEV-ONLY server-side LLM
 * proxy (see server.proxy below). Values are used by the Node dev server
 * process only — they are NEVER injected as VITE_* env vars, so no provider
 * secret can reach the client bundle in dev.
 */
function readCloudflareDevVars(): { accountId: string; apiToken: string } {
  const devVarsPath = path.resolve(__dirname, "../../.dev.vars");
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  let apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!fs.existsSync(devVarsPath)) {
    return { accountId, apiToken };
  }
  const content = fs.readFileSync(devVarsPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (key === "CLOUDFLARE_ACCOUNT_ID" && !accountId) accountId = val;
    if (key === "CLOUDFLARE_API_TOKEN" && !apiToken) apiToken = val;
  }
  return { accountId, apiToken };
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
  plugins: [react(), desktopHtmlPlugin(), stripFfmpegPlugin(isDesktop), pruneFontsPlugin(isDesktop)],
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
    proxy: (() => {
      // EXPLICIT server-side LLM gateway for dev: the client calls
      // same-origin /api/llm/* and this proxy (Node dev-server process, never
      // the browser) attaches the Cloudflare credentials read from the
      // environment or .dev.vars. Mirrors apps/web/functions/api/llm in prod.
      const { accountId, apiToken } = readCloudflareDevVars();
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
