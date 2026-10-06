/**
 * Materializes the MediaPipe runtime + face model that the vision e2e needs
 * into `e2e/.assets` (gitignored), using npm-only sources so the suite runs
 * without CDN access (including in sandboxes where jsdelivr/unpkg/googleapis
 * are unreachable).
 *
 *   wasm/, vision_bundle.cjs   from the installed @mediapipe/tasks-vision
 *   models/face_landmarker.task  from the mediapipe-nodejs npm tarball
 *
 * Person segmentation weights are NOT obtainable offline (every mirror of the
 * official model is either a CDN or a git-lfs pointer), so the spec injects a
 * deterministic mask provider through `setPersonSegmentationEngine()` instead
 * of downloading a model — see e2e/README.md.
 *
 * Usage: node e2e/setup-assets.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, ".assets");
const wasmDir = join(assetsDir, "wasm");
const modelsDir = join(assetsDir, "models");

const FACE_MODEL_PACKAGE = "mediapipe-nodejs@1.2.1";
const FACE_MODEL_TARBALL_PATH =
  "package/public/saved_models/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

function log(message) {
  process.stdout.write(`[vision-assets] ${message}\n`);
}

/** Package root of @mediapipe/tasks-vision (its exports map hides package.json). */
function resolveTasksVisionDir() {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("@mediapipe/tasks-vision"));
  while (!existsSync(join(dir, "wasm"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate @mediapipe/tasks-vision assets");
    dir = parent;
  }
  return dir;
}

/** The Tasks runtime ships with the repo, so wasm + classic bundle are local. */
function copyRuntime() {
  const tasksVisionDir = resolveTasksVisionDir();
  mkdirSync(wasmDir, { recursive: true });
  const wasmFiles = [
    "vision_wasm_internal.js",
    "vision_wasm_internal.wasm",
    "vision_wasm_nosimd_internal.js",
    "vision_wasm_nosimd_internal.wasm",
  ];
  for (const file of wasmFiles) {
    const source = join(tasksVisionDir, "wasm", file);
    if (existsSync(source)) copyFileSync(source, join(wasmDir, file));
  }
  copyFileSync(join(tasksVisionDir, "vision_bundle.cjs"), join(assetsDir, "vision_bundle.cjs"));
  log(`runtime copied from ${tasksVisionDir}`);
}

/** Model weights come from an npm tarball so no CDN/LFS host is required. */
function fetchFaceModel() {
  const target = join(modelsDir, "face_landmarker.task");
  if (existsSync(target) && statSync(target).size > 1_000_000) {
    log("face_landmarker.task already present");
    return;
  }
  mkdirSync(modelsDir, { recursive: true });
  const workDir = join(assetsDir, ".download");
  mkdirSync(workDir, { recursive: true });
  log(`downloading ${FACE_MODEL_PACKAGE} (npm) for face_landmarker.task`);
  try {
    execFileSync(
      "npm",
      ["pack", FACE_MODEL_PACKAGE, "--silent", "--pack-destination", workDir],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const packed = execFileSync("bash", ["-lc", `ls ${workDir}/mediapipe-nodejs-*.tgz`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")[0];
    execFileSync("tar", ["-xzf", packed, "-C", workDir, FACE_MODEL_TARBALL_PATH]);
    copyFileSync(join(workDir, FACE_MODEL_TARBALL_PATH), target);
    log(`face model ready (${(statSync(target).size / 1e6).toFixed(1)} MB)`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

copyRuntime();
fetchFaceModel();
mkdirSync(join(modelsDir), { recursive: true });
log(`assets ready in ${assetsDir}`);
