import { chromium } from "@playwright/test";
import fs from "node:fs";

/**
 * Export-hang repro (mirror conditions), standalone.
 *
 * Emulates the failing /mirror spec export path without running the spec:
 *   clip on timeline + project 576x1104@30 + preview playback first
 *   + deep GPU stage instrumentation (requestAdapter -> requestDevice ->
 *   WebGPURenderer.initialize/initializePipelines) + CDP CPU profile
 *   + 90s "Initializing..." watchdog.
 *
 * env:
 *   HEADED   1 = open a visible Chrome and keep the REAL save dialog so you
 *            can click Save yourself and see the file (implies AGE_MS=0)
 *   AGE_MS   page-age before export (default 300000 = 5 min, mimics the turn)
 *   BASE     dev server (default http://127.0.0.1:5199)
 *   OUT      artifact dir
 */

const HEADED = process.env.HEADED === "1" || process.env.HEADED === "true";
const BASE = process.env.BASE || "http://127.0.0.1:5199";
const SRC = "/Users/hamza/Desktop/k.o.v.e/evaluation-files/milesmorales.mp4.mp4";
const OUT =
  process.env.OUT ||
  "/Users/hamza/Desktop/k.o.v.e/run-outputs/reference-e2e-20261027-192107";
const AGE_MS = Number(process.env.AGE_MS ?? (HEADED ? 0 : 300000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => {
  const s = a.join(" ");
  console.log(s);
  lines.push(s);
};
const finish = (code) => {
  fs.mkdirSync(`${OUT}/screens`, { recursive: true });
  fs.writeFileSync(`${OUT}/repro-v5.log`, `${lines.join("\n")}\n`);
  process.exit(code);
};

// Preflight: the dev server must be up (playwright usually starts it).
try {
  const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`dev server not reachable at ${BASE} (${e?.message ?? e})`);
  console.error("start it first:");
  console.error(
    '  cd /Users/hamza/Desktop/k.o.v.e/apps/web && pnpm exec vite --host 127.0.0.1 --port 5199 --strictPort',
  );
  process.exit(2);
}

const browser = await chromium.launch({
  headless: !HEADED,
  executablePath:
    process.env.KOVE_E2E_CHROMIUM ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleLines = [];
page.on("console", (m) => {
  consoleLines.push(`[${m.type()}] ${m.text()}`);
  if (/error|warn|fail|Renderer|Export|WebGPU|GPU|device|lost|init/i.test(m.text()))
    log(`[console:${m.type()}]`, m.text().slice(0, 400));
});
page.on("pageerror", (e) => log("[pageerror]", e.message.slice(0, 400)));

await page.goto(`${BASE}/#new`, { waitUntil: "domcontentloaded" });
await sleep(5000);
try {
  await page.getByRole("button", { name: "Skip Tour" }).click({ timeout: 5000 });
} catch {}
await page.evaluate(() =>
  document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove()),
);
for (let i = 0; i < 5; i++) {
  const composer = page.getByRole("textbox", { name: "AI edit request" });
  if (await composer.isVisible().catch(() => false)) break;
  await page
    .getByRole("button", { name: "AI Editor chat" })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
  await sleep(2500);
  await page.evaluate(() =>
    document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove()),
  );
}
log("editor chat open");

// ── import + track + clip (mirror setup) ──────────────────────────────────────
await page.locator('input[aria-label="Import media"]').setInputFiles([SRC]);
for (let i = 0; i < 90; i++) {
  if (/milesmorales/i.test(await page.locator("body").innerText().catch(() => ""))) break;
  await sleep(2000);
}
log("source imported");

const firstTrack = page.getByRole("button", { name: "Add your first track" }).first();
if (await firstTrack.isVisible().catch(() => false)) {
  await firstTrack.click();
  log("clicked Add your first track");
  await sleep(1500);
}
const tile = page.locator('img[alt$="milesmorales.mp4.mp4"]').first();
await tile.hover();
await sleep(600);
await page.getByRole("button", { name: "Add to timeline" }).first().click({ timeout: 8000 });
log("clicked Add to timeline");

let clipCount = 0;
for (let i = 0; i < 30; i++) {
  const matchVideo = page.getByRole("button", { name: "Match Video", exact: true }).first();
  if (await matchVideo.isVisible().catch(() => false)) {
    await matchVideo.click().catch(() => {});
    log("answered Match Video Dimensions dialog");
  }
  clipCount = await page.evaluate(async () => {
    const m = await import("/src/stores/project-store.ts");
    return m.useProjectStore.getState().project.timeline.tracks.flatMap((t) => t.clips).length;
  });
  if (clipCount > 0) break;
  await sleep(2000);
}
log("clips on timeline:", clipCount);
if (clipCount === 0) {
  log("ABORT: could not place a clip");
  await page.screenshot({ path: `${OUT}/screens/repro-v5.png` });
  await browser.close();
  finish(1);
}

const settingsResult = await page.evaluate(async () => {
  const m = await import("/src/stores/project-store.ts");
  const r = await m.useProjectStore.getState().updateSettings({ width: 576, height: 1104, frameRate: 30 });
  const s = m.useProjectStore.getState().project.settings;
  return { ok: !r || r.ok !== false, w: s.width, h: s.height, fps: s.frameRate };
});
log("settings now:", JSON.stringify(settingsResult));

// ── playback verify FIRST (the spec failed here too: time ? -> ?) ────────────
const playback = { timeBefore: "?", timeAfter: "?", hashChanged: false, note: "" };
try {
  const crypto = await import("node:crypto");
  let best = null;
  let bestArea = 0;
  for (const c of await page.locator("canvas").all()) {
    const box = await c.boundingBox().catch(() => null);
    if (box && box.width * box.height > bestArea) {
      bestArea = box.width * box.height;
      best = c;
    }
  }
  const timeLocator = page.locator("text=/^\\d{2}:\\d{2}:\\d{2} \\//").first();
  playback.timeBefore = (await timeLocator.innerText().catch(() => "?")) || "?";
  const hash = async (name) => {
    const buf = await best.screenshot({ path: `${OUT}/screens/repro-v5-play-${name}.png` });
    return crypto.createHash("md5").update(buf).digest("hex");
  };
  const hA = await hash("a");
  await page.getByRole("button", { name: /^Play$/ }).first().click({ timeout: 8000 });
  await sleep(4500);
  playback.timeAfter = (await timeLocator.innerText().catch(() => "?")) || "?";
  const hB = await hash("b");
  await page.getByRole("button", { name: /^Pause$/ }).first().click({ timeout: 3000 }).catch(() => {});
  playback.hashChanged = hA !== hB;
  playback.note = playback.hashChanged || playback.timeBefore !== playback.timeAfter;
  log(
    `PLAYBACK: time ${playback.timeBefore} -> ${playback.timeAfter} hashChanged=${playback.hashChanged}`,
  );
} catch (e) {
  playback.note = `error: ${e?.message ?? e}`;
  log("PLAYBACK error:", playback.note);
}

// ── deep stage instrumentation ────────────────────────────────────────────────
const wrapReport = await page.evaluate(async () => {
  const w = window;
  w.__stages = [];
  const rec = (label) => w.__stages.push({ t: Math.round(performance.now()), label });
  const wrap = (proto, name, cls) => {
    if (!proto) return `${cls}:no proto`;
    const orig = proto[name];
    if (typeof orig !== "function") return `${cls}.${name}:missing`;
    if (orig.constructor.name === "AsyncFunction") {
      proto[name] = async function (...args) {
        rec(`${cls}.${name}:enter`);
        try {
          const r = await orig.apply(this, args);
          rec(`${cls}.${name}:exit`);
          return r;
        } catch (e) {
          rec(`${cls}.${name}:throw:${e?.message ?? e}`);
          throw e;
        }
      };
    } else {
      proto[name] = function (...args) {
        rec(`${cls}.${name}:enter`);
        try {
          const r = orig.apply(this, args);
          rec(`${cls}.${name}:ret`);
          return r;
        } catch (e) {
          rec(`${cls}.${name}:throw:${e?.message ?? e}`);
          throw e;
        }
      };
    }
    return `${cls}.${name}:wrapped`;
  };
  const out = [];
  try {
    const ee = await import("/@fs/Users/hamza/Desktop/k.o.v.e/packages/core/src/export/export-engine.ts");
    out.push(wrap(ee.ExportEngine.prototype, "initialize", "ExportEngine"));
    out.push(wrap(ee.ExportEngine.prototype, "initializeGPUForExport", "ExportEngine"));
  } catch (e) {
    out.push(`export-engine import failed: ${e?.message ?? e}`);
  }
  try {
    const ve = await import("/@fs/Users/hamza/Desktop/k.o.v.e/packages/core/src/video/video-engine.ts");
    out.push(wrap(ve.VideoEngine.prototype, "initialize", "VideoEngine"));
    out.push(wrap(ve.VideoEngine.prototype, "initializeGPUCompositor", "VideoEngine"));
  } catch (e) {
    out.push(`video-engine import failed: ${e?.message ?? e}`);
  }
  try {
    const rf = await import("/@fs/Users/hamza/Desktop/k.o.v.e/packages/core/src/video/renderer-factory.ts");
    out.push(wrap(rf.RendererFactory.prototype, "createRenderer", "RendererFactory"));
  } catch (e) {
    out.push(`renderer-factory import failed: ${e?.message ?? e}`);
  }
  try {
    const wg = await import("/@fs/Users/hamza/Desktop/k.o.v.e/packages/core/src/video/webgpu-renderer-impl.ts");
    out.push(wrap(wg.WebGPURenderer.prototype, "initialize", "WebGPURenderer"));
    out.push(wrap(wg.WebGPURenderer.prototype, "initializePipelines", "WebGPURenderer"));
  } catch (e) {
    out.push(`webgpu-renderer import failed: ${e?.message ?? e}`);
  }
  try {
    const ae = await import("/@fs/Users/hamza/Desktop/k.o.v.e/packages/core/src/audio/audio-engine.ts");
    out.push(wrap(ae.AudioEngine.prototype, "initialize", "AudioEngine"));
  } catch (e) {
    out.push(`audio-engine import failed: ${e?.message ?? e}`);
  }
  // GPU: intercept requestAdapter so the returned adapter's requestDevice is
  // also observed (requestDevice lives on GPUAdapter, not navigator.gpu).
  if (navigator.gpu) {
    const gpuProto = Object.getPrototypeOf(navigator.gpu);
    const origRA = gpuProto.requestAdapter;
    gpuProto.requestAdapter = async function (...args) {
      rec("GPU.requestAdapter:enter");
      try {
        const adapter = await origRA.apply(this, args);
        rec(adapter ? "GPU.requestAdapter:ret" : "GPU.requestAdapter:null");
        if (adapter && !adapter.__koveWrapped) {
          const aProto = Object.getPrototypeOf(adapter);
          const origRD = aProto.requestDevice;
          if (typeof origRD === "function") {
            aProto.requestDevice = async function (...a2) {
              rec("GPU.requestDevice:enter");
              try {
                const d = await origRD.apply(this, a2);
                rec("GPU.requestDevice:ret");
                return d;
              } catch (e) {
                rec(`GPU.requestDevice:throw:${e?.message ?? e}`);
                throw e;
              }
            };
            out.push("GPUAdapter.requestDevice:wrapped");
          } else {
            out.push("GPUAdapter.requestDevice:missing");
          }
          adapter.__koveWrapped = true;
        }
        return adapter;
      } catch (e) {
        rec(`GPU.requestAdapter:throw:${e?.message ?? e}`);
        throw e;
      }
    };
    out.push("GPU.requestAdapter:intercepted");
  } else {
    out.push("navigator.gpu missing");
  }
  const OrigWorker = w.Worker;
  w.Worker = class extends OrigWorker {
    constructor(...args) {
      rec(`Worker:new:${String(args[0]).split("/").pop()}`);
      super(...args);
    }
  };
  out.push("Worker:wrapped");
  return out;
});
log("WRAPS:", wrapReport.join(" | "));

// ── page aging (stand-in for the ~6 min AI-turn page life) ───────────────────
if (AGE_MS > 0) {
  log(`aging page ${AGE_MS}ms before export...`);
  await sleep(AGE_MS);
}

// ── save dialog ───────────────────────────────────────────────────────────────
if (HEADED) {
  const hooked = await page.evaluate(() => {
    const w = window;
    if (typeof w.showSaveFilePicker !== "function") return "showSaveFilePicker missing";
    const orig = w.showSaveFilePicker.bind(w);
    w.showSaveFilePicker = async (...args) => {
      const handle = await orig(...args);
      w.__chosenSaveName = handle?.name ?? null;
      return handle;
    };
    return "real save dialog kept (click Save when it opens)";
  });
  log("HEADED:", hooked);
} else {
  const pickerBehaviour = await page.evaluate(() =>
    Promise.race([
      window
        .showSaveFilePicker({ suggestedName: "probe.mp4" })
        .then(() => "resolved", (e) => `rejected: ${e?.name ?? e}`),
      new Promise((r) => setTimeout(() => r("HUNG>6s"), 6000)),
    ]),
  );
  log("PICKER PROBE:", pickerBehaviour);
  const removed = await page.evaluate(() => {
    const w = window;
    try {
      delete w.showSaveFilePicker;
    } catch {
      w.showSaveFilePicker = () => Promise.reject(new Error("removed"));
    }
    return !("showSaveFilePicker" in window);
  });
  log("picker removed:", removed);
}

// ── export attempt with watchdog ──────────────────────────────────────────────
const client = await page.context().newCDPSession(page);
await client.send("Profiler.enable");
await client.send("Profiler.setSamplingInterval", { interval: 1000 });
await client.send("Profiler.start");
log("profiler started");

await page.getByRole("button", { name: "Export", exact: true }).first().click({ timeout: 15000 });
log(HEADED ? "Export clicked — native Save dialog should appear; click Save to write your file" : "Export clicked");

const exportState = async () =>
  page.evaluate(async () => {
    const m = await import("/src/stores/ui-store.ts");
    const es = m.useUIStore.getState().exportState;
    return es ? { ...es } : null;
  });
const readStages = () => page.evaluate(() => (window.__stages ?? []).slice());

let lastPhase = "";
let lastDecile = -1;
let lastSig = "";
let stuckSince = null;
let progressed = false;
let verdict = "unknown";
const stages = [];
const MAX_SEC = HEADED ? 15 * 60 : 6 * 60;
const t0 = Date.now();
for (let i = 0; i < MAX_SEC / 5; i++) {
  await sleep(5000);
  const st = await exportState().catch(() => null);
  const sig = JSON.stringify(st);
  if (sig !== lastSig) {
    lastSig = sig;
    const decile = st ? Math.floor(st.progress / 10) : -1;
    if (st && (st.phase !== lastPhase || decile !== lastDecile || st.error || st.complete)) {
      lastPhase = st.phase;
      lastDecile = decile;
      log(`state[+${((Date.now() - t0) / 1000).toFixed(0)}s]:`, sig);
    } else if (!st) {
      log(`state[+${((Date.now() - t0) / 1000).toFixed(0)}s]:`, sig, "(waiting for Save dialog?)");
    }
  }
  for (const s of (await readStages().catch(() => [])).slice(stages.length)) stages.push(s);
  if (st && (st.error || st.complete)) {
    verdict = st.complete ? "complete" : `in-app error: ${st.error}`;
    break;
  }
  if (st && st.isExporting && st.progress > 0) progressed = true;
  if (st && st.isExporting && !progressed) {
    if (stuckSince === null) stuckSince = Date.now();
    else if (Date.now() - stuckSince >= 90_000) {
      verdict = `STUCK at "${st.phase}" >=90s (last stage entered: ${stages.at(-1)?.label ?? "none"})`;
      break;
    }
  } else {
    stuckSince = null;
  }
}
if (verdict === "unknown") {
  verdict = progressed
    ? `watchdog ended mid-render (progressed, no hang)`
    : `watchdog ended without export starting (last: ${lastSig})`;
}

const { profile } = await client.send("Profiler.stop");
fs.writeFileSync(`${OUT}/repro-v5.cpuprofile`, JSON.stringify(profile));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const selfTime = new Map();
const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
profile.samples.forEach((id, i) => {
  const dt = profile.timeDeltas[i] ?? 0;
  const n = byId.get(id);
  if (!n) return;
  const f = n.callFrame;
  const key = `${f.functionName || "(anon)"} @ ${(f.url || "").split("/").pop()}:${f.lineNumber}`;
  selfTime.set(key, (selfTime.get(key) ?? 0) + dt);
});
const top = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

log("");
log("════════ SUMMARY ════════");
log("VERDICT:", verdict);
log("PLAYBACK:", JSON.stringify(playback));
log("STAGES:");
if (stages.length === 0) log("  (none recorded)");
for (const s of stages) log(`  +${s.t}ms ${s.label}`);
log(`PROFILED ${(total / 1000).toFixed(1)}s:`);
for (const [k, v] of top) log(`  ${((100 * v) / total).toFixed(1)}%  ${k}`);
const stuck = /STUCK|unknown/.test(verdict);
log(
  `KEY QUESTION: did ExportEngine.initialize enter? ` +
    `${stages.some((s) => s.label.startsWith("ExportEngine.initialize")) ? "YES" : "NO"} ; ` +
    `last stage: ${stages.at(-1)?.label ?? "none"}`,
);
fs.writeFileSync(`${OUT}/repro-v5-stages.json`, JSON.stringify({ verdict, playback, stages, wrapReport }, null, 1));
fs.writeFileSync(`${OUT}/repro-v5-console.json`, JSON.stringify(consoleLines.slice(-500), null, 1));
await page.screenshot({ path: `${OUT}/screens/repro-v5.png` });
await browser.close();
finish(stuck ? 3 : 0);
