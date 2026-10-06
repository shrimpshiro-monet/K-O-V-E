/**
 * Test double for the MediaPipe Tasks runtime, used by the vision e2e.
 *
 * The person-segmentation worker loads its MediaPipe runtime with
 * `importScripts(assets.tasksVisionBundleUrl)` and reads `FilesetResolver` /
 * `ImageSegmenter` off the bundle's CommonJS exports. This file provides those
 * two globals with a synthetic, drifting subject matte.
 *
 * Why this shape: the official selfie-segmenter weights are not obtainable
 * offline (every mirror is a CDN URL or a git-lfs pointer), but everything
 * *around* the model is real and worth exercising — the worker protocol, the
 * temporal mask smoothing, the segmentation engine's request handling, the
 * rotoscope geometry and the mask write. Only model inference is replaced.
 *
 * The face path is unaffected: it loads the real runtime from node_modules.
 */

const ellipse = (timeMs) => {
  const t = timeMs / 1000;
  return {
    cx: 0.5 + 0.06 * Math.sin(t * 0.9),
    cy: 0.45 + 0.02 * Math.cos(t * 0.6),
    rx: 0.24 + 0.01 * Math.sin(t * 0.7),
    ry: 0.4,
  };
};

const buildMask = (width, height, timeMs) => {
  const { cx, cy, rx, ry } = ellipse(timeMs);
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const ny = (y / height - cy) / ry;
    for (let x = 0; x < width; x += 1) {
      const nx = (x / width - cx) / rx;
      const distance = Math.sqrt(nx * nx + ny * ny);
      // Soft edge: 1 inside the subject, fading to 0 just outside it.
      const value = Math.min(1, Math.max(0, (1 - distance) / 0.2 + 0.5));
      values[y * width + x] = value;
    }
  }
  return {
    width,
    height,
    getAsFloat32Array: () => values,
    close: () => undefined,
  };
};

exports.FilesetResolver = {
  forVisionTasks: () => Promise.resolve({ wasm: "stubbed" }),
};

exports.ImageSegmenter = {
  createFromOptions: () =>
    Promise.resolve({
      segmentForVideo: (canvas, timestampMs, callback) => {
        callback({
          confidenceMasks: [buildMask(canvas.width, canvas.height, timestampMs)],
        });
      },
      segment: (canvas, callback) => {
        callback({
          confidenceMasks: [buildMask(canvas.width, canvas.height, 0)],
        });
      },
      close: () => undefined,
    }),
};
