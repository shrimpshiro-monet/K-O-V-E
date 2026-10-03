import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import { stripFfmpegPlugin } from "./vite-plugins/strip-ffmpeg";
import { pruneFontsPlugin } from "./vite-plugins/prune-fonts";

const isDesktop = process.env.KOVE_ADVANCED_DESKTOP === "1";

/**
 * Reads .dev.vars (Cloudflare Workers local env) and injects CLOUDFLARE_*
 * values as VITE_* env vars so the frontend can auto-populate during dev.
 */
function cloudflareDevVarsPlugin() {
  const devVarsPath = path.resolve(__dirname, "../../.dev.vars");
  return {
    name: "cloudflare-dev-vars",
    config() {
      if (!fs.existsSync(devVarsPath)) return;
      const content = fs.readFileSync(devVarsPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key.startsWith("CLOUDFLARE_")) {
          const viteKey = `VITE_${key}`;
          if (!process.env[viteKey]) {
            process.env[viteKey] = val;
          }
        }
      }
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
  plugins: [react(), cloudflareDevVarsPlugin(), desktopHtmlPlugin(), stripFfmpegPlugin(isDesktop), pruneFontsPlugin(isDesktop)],
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
      // Read the API token directly from .dev.vars
      const devVarsPath = path.resolve(__dirname, "../../.dev.vars");
      let apiToken = "";
      if (fs.existsSync(devVarsPath)) {
        for (const line of fs.readFileSync(devVarsPath, "utf-8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("CLOUDFLARE_API_TOKEN=")) {
            apiToken = trimmed.slice("CLOUDFLARE_API_TOKEN=".length).trim();
            break;
          }
        }
      }
      console.log("[vite] Cloudflare proxy token:", apiToken ? `${apiToken.slice(0, 8)}...` : "MISSING");
      return {
        "/api/cf-ai": {
          target: "https://api.cloudflare.com",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api\/cf-ai/, ""),
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
