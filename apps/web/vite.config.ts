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
      // credentialless (not require-corp) so cross-origin fonts/sourcemaps
      // without a CORP header still load; cross-origin isolation is retained.
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: (() => {
      // Read both Cloudflare token/account pairs directly from .dev.vars.
      // The Vite plugin maps CLOUDFLARE_* -> VITE_CLOUDFLARE_* generically, so
      // the _2 keys reach the client without any plugin change.
      const devVarsPath = path.resolve(__dirname, "../../.dev.vars");
      const vars: Record<string, string> = {};
      if (fs.existsSync(devVarsPath)) {
        for (const line of fs.readFileSync(devVarsPath, "utf-8").split("\n")) {
          const trimmed = line.trim();
          const eq = trimmed.indexOf("=");
          if (trimmed.startsWith("CLOUDFLARE_") && eq > 0) {
            vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).trim();
          }
        }
      }
      const tokens = [
        ["CLOUDFLARE_API_TOKEN", vars.CLOUDFLARE_API_TOKEN ?? ""],
        ["CLOUDFLARE_API_TOKEN_2", vars.CLOUDFLARE_API_TOKEN_2 ?? ""],
      ] as const;
      for (const [key, token] of tokens) {
        console.log(
          `[vite] ${key}:`,
          token ? `${token.slice(0, 8)}...` : "MISSING",
        );
      }
      const route = (strip: RegExp, token: string): Record<string, unknown> => ({
        target: "https://api.cloudflare.com",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(strip, ""),
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 120000,
        proxyTimeout: 120000,
      });
      // Vite matches contexts with url.startsWith(context), so "/api/cf-ai-2"
      // would be captured by the "/api/cf-ai" route. Regex contexts keep the
      // two slots mutually exclusive regardless of key order.
      return {
        "^/api/cf-ai-2(?:/|$)": route(/^\/api\/cf-ai-2/, tokens[1][1]),
        "^/api/cf-ai(?:/|$)": route(/^\/api\/cf-ai/, tokens[0][1]),
      };
    })(),
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
});
