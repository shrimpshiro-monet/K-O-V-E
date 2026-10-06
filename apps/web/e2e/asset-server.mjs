/**
 * Static server for the vision e2e: serves `e2e/.assets` (MediaPipe runtime +
 * face model) and `e2e/fixtures` over HTTP with the cross-origin headers a
 * COEP-isolated page needs.
 *
 * Used by playwright.config.ts as a webServer; logs to stdout so Playwright's
 * webServer output captures it.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [join(here, ".assets"), join(here, "fixtures")];
const PORT = Number(process.env.KOVE_E2E_ASSET_PORT ?? 8788);
// The segmentation worker loads its MediaPipe runtime from the bundle URL; when
// the stub is enabled that URL serves the synthetic model double instead of the
// real bundle (the face path loads the real runtime itself, so it is not
// affected). See stub-segmenter-runtime.cjs and e2e/README.md.
const STUB_BUNDLE = process.env.KOVE_E2E_STUB_SEGMENTER === "1";

const TYPES = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".cjs": "text/javascript",
  ".mjs": "text/javascript",
  ".tflite": "application/octet-stream",
  ".task": "application/octet-stream",
  ".data": "application/octet-stream",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
};

async function resolveFile(relPath) {
  for (const root of ROOTS) {
    const candidate = normalize(join(root, relPath));
    if (!candidate.startsWith(root)) continue;
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next root
    }
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file =
    STUB_BUNDLE && rel === "vision_bundle.cjs"
      ? join(here, "stub-segmenter-runtime.cjs")
      : await resolveFile(rel);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end(`not found: ${rel}`);
    return;
  }
  if (STUB_BUNDLE && rel === "vision_bundle.cjs") {
    process.stdout.write("[vision-assets] serving stubbed segmentation runtime\n");
  }
  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(body);
}).listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`[vision-assets] serving ${ROOTS.join(", ")} on http://0.0.0.0:${PORT}\n`);
});
