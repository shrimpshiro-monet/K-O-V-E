import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

/**
 * Reference-flow e2e: `/reference` and `/mirror` driven through the real chat
 * in AI (`ai`) analysis mode, against real local media, ending in a real
 * export.
 *
 * What is real here: Chromium, the editor, both local files, the reference
 * measurement pipeline, the OmniRoute chat gateway, tool approvals, the export
 * encoder. No stubs are injected by this spec and no state is fabricated.
 *
 * Known environment fact this spec measures and reports instead of hiding:
 * the AI vision worker (`VISION_WORKER_URL` / `KOVE_VISION_WORKER_URL`) is not
 * configured in this workspace. `extract_segments` in `ai` mode therefore runs
 * the local Python analysis engine (`packages/python-engine`) and says so in
 * its tool summary ("AI vision didn't work ... used instead"); only when that
 * engine is also unreachable does it fall back to a metadata-only SegmentMap.
 * The spec records the tool summary and the network log as evidence and
 * surfaces it in the run result.
 *
 * Artifacts land in $KOVE_E2E_OUT (screens/, json snapshots, netlog, export).
 */

const repoRoot = resolve(process.cwd(), "../..");
const SRC = join(repoRoot, "evaluation-files/milesmorales.mp4.mp4");
const REF = join(
  repoRoot,
  "evaluation-files/reference videos (priority, needs to look LIKE or BETTER than)/SPIDERMAN (IMPORTANT).MP4",
);
const OUT = resolve(
  process.env.KOVE_E2E_OUT ?? join(process.cwd(), "test-results", "reference-mirror-ai"),
);

mkdirSync(join(OUT, "screens"), { recursive: true });

const TURN_TIMEOUT_MS = 15 * 60_000;
const EXPORT_TIMEOUT_MS = 12 * 60_000;
const TEST_TIMEOUT_MS = 35 * 60_000;

const t0All = Date.now();
const log = (...args: unknown[]): void => {
  const stamp = `[+${((Date.now() - t0All) / 1000).toFixed(0)}s]`;
  // eslint-disable-next-line no-console
  console.log(stamp, ...args);
};

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
}

// ── in-page snapshots ────────────────────────────────────────────────────────

interface MediaSnap {
  id: string;
  name: string;
  type: string;
  analysisRole: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  isPending: boolean;
}

interface ClipSnap {
  id: string;
  trackId: string;
  trackName: string;
  trackType: string;
  mediaId: string;
  mediaName: string | null;
  startTime: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  effects: string[];
  audioEffects: string[];
  keyframeCount: number;
  keyframeProps: string[];
  transform: { position: unknown; scale: unknown; rotation: unknown; opacity: unknown } | null;
  hasColorGrading: boolean;
  volume: number;
  speed: number | null;
  fade: { fadeIn: number; fadeOut: number } | null;
  automation: boolean;
}

interface ProjectSnap {
  projectId: string;
  projectName: string;
  settings: { width: number; height: number; frameRate: number };
  duration: number;
  media: MediaSnap[];
  tracks: Array<{ id: string; name: string; type: string; clipCount: number; transitionCount: number }>;
  clips: ClipSnap[];
  transitions: Array<{ trackName: string; type: string; duration: number; clipAId: string; clipBId: string | null; edge: string | null }>;
  textClips: Array<{ text: string; startTime: number; duration: number }>;
  subtitles: number;
  mirrorProfile: boolean;
  directorPlanRevision: number | null;
}

async function projectSnapshot(page: Page): Promise<ProjectSnap> {
  return page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mod = await import("/src/stores/project-store.ts");
    const store = mod.useProjectStore.getState();
    const p = store.project;
    const media = ((p.mediaLibrary?.items ?? []) as any[]).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? ""),
      type: String(m.type ?? ""),
      analysisRole: (m.analysisRole as string | undefined) ?? null,
      duration: (m.metadata?.duration as number | undefined) ?? null,
      width: (m.metadata?.width as number | undefined) ?? null,
      height: (m.metadata?.height as number | undefined) ?? null,
      isPending: !!m.isPending,
    }));
    const mediaById = new Map(media.map((m) => [m.id, m]));
    const clips: any[] = [];
    const transitions: any[] = [];
    const tracks = ((p.timeline?.tracks ?? []) as any[]).map((t) => {
      for (const c of (t.clips ?? []) as any[]) {
        clips.push({
          id: String(c.id),
          trackId: String(t.id),
          trackName: String(t.name ?? ""),
          trackType: String(t.type ?? ""),
          mediaId: String(c.mediaId ?? ""),
          mediaName: mediaById.get(String(c.mediaId))?.name ?? null,
          startTime: Number(c.startTime ?? 0),
          duration: Number(c.duration ?? 0),
          inPoint: Number(c.inPoint ?? 0),
          outPoint: Number(c.outPoint ?? 0),
          effects: ((c.effects ?? []) as any[]).map((e) => String(e.type)),
          audioEffects: ((c.audioEffects ?? []) as any[]).map((e) => String(e.type)),
          keyframeCount: (c.keyframes ?? []).length,
          keyframeProps: [...new Set(((c.keyframes ?? []) as any[]).map((k) => String(k.property)))],
          transform: c.transform
            ? {
                position: c.transform.position,
                scale: c.transform.scale,
                rotation: c.transform.rotation,
                opacity: c.transform.opacity,
              }
            : null,
          hasColorGrading: !!c.colorGrading,
          volume: Number(c.volume ?? 1),
          speed: typeof c.speed === "number" ? c.speed : null,
          fade: c.fade ?? null,
          automation: !!(c.automation?.volume?.length || c.automation?.pan?.length),
        });
      }
      for (const tr of (t.transitions ?? []) as any[]) {
        transitions.push({
          trackName: String(t.name ?? ""),
          type: String(tr.type ?? ""),
          duration: Number(tr.duration ?? 0),
          clipAId: String(tr.clipAId ?? ""),
          clipBId: tr.clipBId ? String(tr.clipBId) : null,
          edge: tr.edge ? String(tr.edge) : null,
        });
      }
      return {
        id: String(t.id),
        name: String(t.name ?? ""),
        type: String(t.type ?? ""),
        clipCount: ((t.clips ?? []) as any[]).length,
        transitionCount: ((t.transitions ?? []) as any[]).length,
      };
    });
    const textClips = ((p.textClips ?? []) as any[]).map((tc) => ({
      text: String(tc.text ?? ""),
      startTime: Number(tc.startTime ?? 0),
      duration: Number(tc.duration ?? 0),
    }));
    return {
      projectId: String(p.id),
      projectName: String(p.name ?? ""),
      settings: {
        width: Number(p.settings?.width ?? 0),
        height: Number(p.settings?.height ?? 0),
        frameRate: Number(p.settings?.frameRate ?? 0),
      },
      duration: Number(p.timeline?.duration ?? 0),
      media,
      tracks,
      clips: clips as never,
      transitions: transitions as never,
      textClips: textClips as never,
      subtitles: (p.timeline?.subtitles ?? []).length,
      mirrorProfile: !!p.mirrorProfile,
      directorPlanRevision:
        typeof p.directorPlanState?.revision === "number" ? p.directorPlanState.revision : null,
      hasOpenProject: store.hasOpenProject,
    } as never;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
}

interface ToolCallSnap {
  name: string;
  status: string;
  ok: boolean | null;
  summary: string | null;
  error: string | null;
}

interface ChatSnap {
  status: string;
  analysisMode: string;
  error: string | null;
  pendingConfirm: string | null;
  reference: { name: string } | null;
  notices: string[];
  messages: Array<{ role: string; text: string; toolCalls: ToolCallSnap[] }>;
  usage: { inputTokens: number; outputTokens: number };
}

async function chatSnapshot(page: Page): Promise<ChatSnap> {
  return page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const src = await (await fetch("/src/components/editor/chat/ChatPanel.tsx")).text();
    const match = [...src.matchAll(/from\s+"([^"]*chat-store[^"]*)"/g)][0];
    if (!match) throw new Error("chat-store import specifier not found in ChatPanel.tsx");
    const cs = await import(match[1] as string);
    const s = cs.useChatStore.getState();
    const messages = (s.messages ?? []).map((m: any) => ({
      role: String(m.role),
      text: String(m.text ?? ""),
      notice: m.notice ? String(m.notice) : null,
      toolCalls: ((m.toolCalls ?? []) as any[]).map((t) => ({
        name: String(t.name),
        status: String(t.status),
        ok: typeof t.result?.ok === "boolean" ? t.result.ok : null,
        summary: t.result?.summary ? String(t.result.summary) : null,
        error: t.result?.error?.message ? String(t.result.error.message) : null,
      })),
    }));
    return {
      status: String(s.status),
      analysisMode: String(s.analysisMode),
      error: s.error ? String(s.error) : null,
      pendingConfirm: s.pendingConfirm?.call?.name ? String(s.pendingConfirm.call.name) : null,
      reference: s.reference ? { name: String(s.reference.name) } : null,
      notices: messages.filter((m: any) => m.notice).map((m: any) => m.notice),
      messages: messages.map((m: any) => ({
        role: m.role,
        text: m.text,
        toolCalls: m.toolCalls,
      })),
      usage: {
        inputTokens: Number(s.usage?.inputTokens ?? 0),
        outputTokens: Number(s.usage?.outputTokens ?? 0),
      },
    } as never;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
}

interface ExportStateSnap {
  isExporting: boolean;
  progress: number;
  phase: string;
  error: string | null;
  complete: boolean;
}

async function exportStateSnapshot(page: Page): Promise<ExportStateSnap | null> {
  return page.evaluate(async () => {
    try {
      const mod = await import("/src/stores/ui-store.ts");
      const es = mod.useUIStore.getState().exportState as Record<string, unknown> | undefined;
      if (!es) return null;
      return {
        isExporting: !!es.isExporting,
        progress: Number(es.progress ?? 0),
        phase: String(es.phase ?? ""),
        error: es.error ? String(es.error) : null,
        complete: !!es.complete,
      } as never;
    } catch {
      return null;
    }
  });
}

// ── UI helpers (patterns proven by apps/studio/e2e-replicate.mjs) ───────────

async function dismissBlockingOverlays(page: Page): Promise<void> {
  const overlay = page.locator("div.fixed.inset-0.z-\\[100\\]").first();
  if (!(await overlay.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
  await page
    .evaluate(() => {
      document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove());
    })
    .catch(() => {});
}

async function openComposer(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "AI edit request" });
  for (let i = 0; i < 5 && !(await composer.isVisible().catch(() => false)); i++) {
    await dismissBlockingOverlays(page);
    await page
      .getByRole("button", { name: "AI Editor chat" })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
  }
  await expect(composer, "chat composer must be reachable").toBeVisible({ timeout: 20000 });
}

async function clickApprove(page: Page): Promise<string | null> {
  const all = page.getByRole("button", { name: "Approve all this turn", exact: true }).first();
  const one = page.getByRole("button", { name: "Approve", exact: true }).first();
  if (await all.isVisible().catch(() => false)) {
    await all.click({ timeout: 5000 }).catch(() => {});
    return "approve_for_turn";
  }
  if (await one.isVisible().catch(() => false)) {
    await one.click({ timeout: 5000 }).catch(() => {});
    return "approve";
  }
  return null;
}

interface NetEntry {
  t: number;
  status: number | null;
  url: string;
}

function attachNetworkLog(page: Page, store: NetEntry[]): void {
  page.on("response", (r) => {
    store.push({ t: Date.now(), status: r.status(), url: r.url() });
  });
  page.on("requestfailed", (r) => {
    store.push({ t: Date.now(), status: null, url: r.url() });
  });
}

// ── run driver ───────────────────────────────────────────────────────────────

interface DriveResult {
  midSnapshot: ProjectSnap | null;
  timedOut: boolean;
  finalChat: ChatSnap;
  approvals: Array<{ tool: string; kind: string; at: number }>;
  events: string[];
}

async function driveTurn(page: Page, tag: string): Promise<DriveResult> {
  const events: string[] = [];
  const approvals: DriveResult["approvals"] = [];
  let midSnapshot: ProjectSnap | null = null;
  let lastFingerprint = "";
  let lastNotice = "";
  let stableSince = Date.now();
  let timedOut = false;
  const startedAt = Date.now();
  const deadline = startedAt + TURN_TIMEOUT_MS;
  let lastHeartbeat = 0;
  let finalChat = await chatSnapshot(page);

  const note = (message: string): void => {
    events.push(`${Date.now() - startedAt}ms ${message}`);
    log(`[${tag}]`, message);
  };

  while (Date.now() < deadline) {
    await dismissBlockingOverlays(page);

    const chat = await chatSnapshot(page).catch(() => finalChat);
    finalChat = chat;

    const fingerprint = JSON.stringify({
      status: chat.status,
      last: chat.messages.slice(-2),
    });
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      stableSince = Date.now();
      const assistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
      const tools = assistant?.toolCalls.map((t) => `${t.name}:${t.status}`) ?? [];
      if (tools.length) note(`tools: ${tools.slice(-4).join(", ")}`);
      if (assistant?.text) {
        const tail = assistant.text.replace(/\s+/g, " ").slice(-220);
        if (tail) note(`assistant: ${tail}`);
      }
    }

    const latestNotice = chat.notices.at(-1) ?? "";
    if (latestNotice && latestNotice !== lastNotice) {
      lastNotice = latestNotice;
      note(`notice: ${latestNotice}`);
    }

    if (midSnapshot === null) {
      const current = await projectSnapshot(page).catch(() => null);
      if (current && current.clips.length > 0) {
        midSnapshot = current;
        writeJson(`${tag}-mid.json`, current);
        note(`timeline populated mid-turn: ${current.clips.length} clip(s)`);
        await page.screenshot({ path: join(OUT, "screens", `${tag}-04-mid-turn.png`) });
      }
    }

    if (chat.pendingConfirm) {
      const kind = await clickApprove(page);
      if (kind) {
        approvals.push({ tool: chat.pendingConfirm, kind, at: Date.now() - startedAt });
        note(`approved ${kind} for ${chat.pendingConfirm}`);
        stableSince = Date.now();
      }
    }

    if (Date.now() - lastHeartbeat > 15000) {
      lastHeartbeat = Date.now();
      const proj = await projectSnapshot(page).catch(() => null);
      note(
        `state: status=${chat.status} mode=${chat.analysisMode} clips=${proj?.clips.length ?? "?"} tokens=${chat.usage.inputTokens}/${chat.usage.outputTokens}` +
          (chat.pendingConfirm ? ` pending=${chat.pendingConfirm}` : ""),
      );
    }

    const stopVisible = await page
      .getByRole("button", { name: "Stop", exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    const idle = chat.status === "idle" || chat.status === "error";
    const ranFor = Date.now() - startedAt;
    if (idle && !stopVisible && Date.now() - stableSince > 15000 && ranFor > 45000) {
      note(`turn finished: status=${chat.status} after ${(ranFor / 1000).toFixed(0)}s`);
      break;
    }
    await page.waitForTimeout(2500);
  }

  if (Date.now() >= deadline) {
    timedOut = true;
    note("TURN TIMED OUT");
  }

  return { midSnapshot, timedOut, finalChat, approvals, events };
}

// ── change classification ────────────────────────────────────────────────────

function classifyChanges(before: ProjectSnap, after: ProjectSnap): Record<string, unknown> {
  const videoClips = after.clips.filter((c) => c.trackType !== "audio" && c.trackType !== "text");
  const boundaries = [...new Set(videoClips.map((c) => Number(c.startTime.toFixed(3))))].sort(
    (a, b) => a - b,
  );
  const cameraKeyframeClips = after.clips.filter((c) =>
    c.keyframeProps.some((p) => /position|scale|rotation/i.test(p)),
  );
  const effectTypes = [...new Set(after.clips.flatMap((c) => c.effects))];
  const audioEffectTypes = [...new Set(after.clips.flatMap((c) => c.audioEffects))];
  return {
    cutsAndTiming: {
      clipCountBefore: before.clips.length,
      clipCountAfter: after.clips.length,
      videoClipCount: videoClips.length,
      cutBoundaries: boundaries,
      timelineDurationBefore: before.duration,
      timelineDurationAfter: after.duration,
      settingsAfter: after.settings,
    },
    cameraAndKeyframes: {
      clipsWithKeyframes: after.clips.filter((c) => c.keyframeCount > 0).length,
      totalKeyframes: after.clips.reduce((sum, c) => sum + c.keyframeCount, 0),
      cameraKeyframeClips: cameraKeyframeClips.length,
      properties: [...new Set(after.clips.flatMap((c) => c.keyframeProps))],
    },
    text: {
      textClipCount: after.textClips.length,
      texts: after.textClips.map((t) => t.text),
      subtitleCount: after.subtitles,
    },
    transitionsAndEffects: {
      transitionCount: after.transitions.length,
      transitions: after.transitions,
      effectTypes,
      clipsWithEffects: after.clips.filter((c) => c.effects.length > 0).length,
    },
    color: {
      clipsWithColorGrading: after.clips.filter((c) => c.hasColorGrading).length,
    },
    audio: {
      audioEffectTypes,
      clipsWithFade: after.clips.filter((c) => !!c.fade).length,
      clipsWithNonDefaultVolume: after.clips.filter((c) => Math.abs(c.volume - 1) > 0.001).length,
      clipsWithSpeedChange: after.clips.filter((c) => c.speed !== null && c.speed !== 1).length,
      clipsWithAutomation: after.clips.filter((c) => c.automation).length,
    },
    structure: {
      mirrorProfile: after.mirrorProfile,
      directorPlanRevision: after.directorPlanRevision,
      trackCount: after.tracks.length,
    },
  };
}

// ── export ───────────────────────────────────────────────────────────────────

interface ExportOutcome {
  attempted: boolean;
  ok: boolean;
  file: string | null;
  bytes: number | null;
  ffprobe: unknown;
  state: ExportStateSnap | null;
  error: string | null;
  fsaPickerPresent: boolean;
  fsaPickerRemoved: boolean;
  notes: string[];
  stages?: Array<{ t: number; label: string }>;
  profileTop?: Array<{ key: string; pct: number }>;
  consoleLines?: string[];
}

/**
 * Wraps every await between beginExport() and the first exportVideo yield
 * (engine.initialize / initializeGPUForExport / GPU / Worker) so a hang can be
 * attributed to an exact stage. Pure page-level observation; app code untouched.
 */
async function installExportStages(page: Page, root: string): Promise<string[]> {
  return page.evaluate(async (rootDir: string) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any;
    w.__exportStages = [];
    const rec = (label: string): void => {
      w.__exportStages.push({ t: Math.round(performance.now()), label });
    };
    const wrap = (proto: any, name: string, cls: string): string => {
      if (!proto) return `${cls}:no proto`;
      const orig = proto[name];
      if (typeof orig !== "function") return `${cls}.${name}:missing`;
      if (orig.constructor.name === "AsyncFunction") {
        proto[name] = async function (...args: unknown[]) {
          rec(`${cls}.${name}:enter`);
          try {
            const r = await orig.apply(this, args);
            rec(`${cls}.${name}:exit`);
            return r;
          } catch (e) {
            rec(`${cls}.${name}:throw:${(e as Error)?.message ?? e}`);
            throw e;
          }
        };
      } else {
        proto[name] = function (...args: unknown[]) {
          rec(`${cls}.${name}:enter`);
          try {
            const r = orig.apply(this, args);
            rec(`${cls}.${name}:ret`);
            return r;
          } catch (e) {
            rec(`${cls}.${name}:throw:${(e as Error)?.message ?? e}`);
            throw e;
          }
        };
      }
      return `${cls}.${name}:wrapped`;
    };
    const out: string[] = [];
    try {
      const ee = await import(`/@fs/${rootDir}/packages/core/src/export/export-engine.ts`);
      out.push(wrap(ee.ExportEngine.prototype, "initialize", "ExportEngine"));
      out.push(wrap(ee.ExportEngine.prototype, "initializeGPUForExport", "ExportEngine"));
    } catch (e) {
      out.push(`export-engine import failed: ${(e as Error)?.message ?? e}`);
    }
    try {
      const ve = await import(`/@fs/${rootDir}/packages/core/src/video/video-engine.ts`);
      out.push(wrap(ve.VideoEngine.prototype, "initialize", "VideoEngine"));
      out.push(wrap(ve.VideoEngine.prototype, "initializeGPUCompositor", "VideoEngine"));
    } catch (e) {
      out.push(`video-engine import failed: ${(e as Error)?.message ?? e}`);
    }
    try {
      const ae = await import(`/@fs/${rootDir}/packages/core/src/audio/audio-engine.ts`);
      out.push(wrap(ae.AudioEngine.prototype, "initialize", "AudioEngine"));
    } catch (e) {
      out.push(`audio-engine import failed: ${(e as Error)?.message ?? e}`);
    }
    try {
      const fx = await import(`/@fs/${rootDir}/packages/core/src/audio/audio-effects-engine.ts`);
      out.push(wrap(fx.AudioEffectsEngine.prototype, "initialize", "AudioFX"));
    } catch (e) {
      out.push(`audio-effects import failed: ${(e as Error)?.message ?? e}`);
    }
    if (navigator.gpu) {
      out.push(wrap(Object.getPrototypeOf(navigator.gpu), "requestAdapter", "GPU"));
      out.push(wrap(Object.getPrototypeOf(navigator.gpu), "requestDevice", "GPU"));
    } else {
      out.push("navigator.gpu missing");
    }
    const OrigWorker = w.Worker;
    w.Worker = class extends OrigWorker {
      constructor(...args: unknown[]) {
        rec(`Worker:new:${String(args[0]).split("/").pop()}`);
        super(...(args as ConstructorParameters<typeof Worker>));
      }
    };
    out.push("Worker:wrapped");
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return out;
  }, root);
}

async function readExportStages(page: Page): Promise<Array<{ t: number; label: string }>> {
  return page.evaluate(() => ((window as unknown as { __exportStages?: Array<{ t: number; label: string }> }).__exportStages ?? []));
}

async function runExport(page: Page, tag: string): Promise<ExportOutcome> {
  const outcome: ExportOutcome = {
    attempted: true,
    ok: false,
    file: null,
    bytes: null,
    ffprobe: null,
    state: null,
    error: null,
    fsaPickerPresent: false,
    fsaPickerRemoved: false,
    notes: [],
  };

  const probe = await page.evaluate(() => "showSaveFilePicker" in window);
  outcome.fsaPickerPresent = probe;

  // The OS save dialog cannot open in headless Chromium, and the app's own
  // fallback (streaming to a downloaded file) is the supported path there.
  // Removing the API at page level selects that real app code path; nothing in
  // the app is modified and the encoder runs unmodified.
  if (probe) {
    const removed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      try {
        delete w.showSaveFilePicker;
      } catch {
        w.showSaveFilePicker = () =>
          Promise.reject(new DOMException("File picker unavailable", "NotSupportedError"));
      }
      return !("showSaveFilePicker" in window);
    });
    outcome.fsaPickerRemoved = removed;
    outcome.notes.push(
      removed
        ? "showSaveFilePicker removed at page level so the app's anchor-download fallback runs (headless cannot show the OS dialog)"
        : "could not remove showSaveFilePicker; attempting natural path",
    );
  }

  await dismissBlockingOverlays(page);

  // Diagnostics for the run-2 failure mode (phase stuck at "Initializing...").
  const wrapReport = await installExportStages(page, repoRoot).catch((e) => [`install failed: ${e}`]);
  log(`[${tag}] export stage wraps: ${wrapReport.join(" | ")}`);
  const consoleLines: string[] = [];
  const onConsole = (m: { type(): string; text(): string }): void => {
    consoleLines.push(`[${m.type()}] ${m.text()}`);
  };
  page.on("console", onConsole);
  let cdp: { send: (method: string, params?: object) => Promise<unknown>; detach: () => Promise<void> } | null = null;
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 1000 });
    await session.send("Profiler.start");
    cdp = session;
  } catch (error) {
    log(`[${tag}] CDP profiler unavailable: ${error instanceof Error ? error.message : String(error)}`);
    cdp = null;
  }

  const downloadPromise = page
    .waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS })
    .catch(() => null);

  const exportButton = page.getByRole("button", { name: "Export", exact: true }).first();
  try {
    await exportButton.click({ timeout: 20000 });
  } catch (error) {
    outcome.error = `Export button could not be clicked: ${error instanceof Error ? error.message : String(error)}`;
    outcome.notes.push(outcome.error);
    await page.screenshot({ path: join(OUT, "screens", `${tag}-06-export.png`) }).catch(() => {});
    return outcome;
  }
  log(`[${tag}] Export clicked (fsaPickerPresent=${probe})`);

  const pollStart = Date.now();
  let download: Awaited<typeof downloadPromise> = null;
  let initializingSince: number | null = null;
  while (Date.now() - pollStart < EXPORT_TIMEOUT_MS) {
    const raced = await Promise.race([
      downloadPromise.then((d) => ({ d })),
      page.waitForTimeout(5000).then(() => null),
    ]);
    if (raced) {
      download = raced.d;
      break;
    }
    const state = await exportStateSnapshot(page).catch(() => null);
    if (state) {
      outcome.state = state;
      if (Math.round(state.progress) % 25 === 0) {
        log(`[${tag}] export: ${state.progress.toFixed(0)}% ${state.phase}`);
      }
      if (state.error) {
        outcome.error = state.error;
        outcome.notes.push(`export failed in-app: ${state.error}`);
        break;
      }
      if (state.complete) {
        outcome.notes.push("app reports export complete but no download event fired");
        break;
      }
      if (state.isExporting && state.progress === 0 && state.phase === "Initializing...") {
        initializingSince ??= Date.now();
        if (Date.now() - initializingSince > 90_000) {
          outcome.error = `export stuck at "Initializing..." for 90s (progress 0)`;
          outcome.notes.push(outcome.error);
          break;
        }
      } else {
        initializingSince = null;
      }
    }
  }

  // Stage/console/CPU-profile diagnostics — attributes an export hang to an
  // exact await (engine.initialize vs pre-yield GPU init) instead of guessing.
  outcome.stages = await readExportStages(page).catch(() => []);
  if (cdp) {
    try {
      const { profile } = (await cdp.send("Profiler.stop")) as {
        profile: {
          nodes: Array<{ id: number; callFrame: { functionName?: string; url?: string; lineNumber?: number } }>;
          samples: number[];
          timeDeltas: number[];
        };
      };
      writeFileSync(join(OUT, `${tag}-export-profile.cpuprofile`), JSON.stringify(profile));
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const selfTime = new Map<string, number>();
      const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
      profile.samples.forEach((id, i) => {
        const dt = profile.timeDeltas[i] ?? 0;
        const f = byId.get(id)?.callFrame;
        if (!f) return;
        const key = `${f.functionName || "(anonymous)"} @ ${(f.url || "").split("/").pop()}:${f.lineNumber}`;
        selfTime.set(key, (selfTime.get(key) ?? 0) + dt);
      });
      outcome.profileTop = [...selfTime.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([key, v]) => ({ key, pct: total > 0 ? Math.round((1000 * v) / total) / 10 : 0 }));
    } catch (error) {
      log(`[${tag}] profiler stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await cdp.detach().catch(() => {});
  }
  outcome.consoleLines = consoleLines.slice(-500);
  page.off("console", onConsole);
  if (outcome.stages?.length) {
    log(`[${tag}] export stages: ${outcome.stages.map((s) => s.label).join(" > ")}`);
  }
  if (outcome.profileTop?.length) {
    log(`[${tag}] profile top: ${outcome.profileTop.slice(0, 8).map((p) => `${p.pct}% ${p.key}`).join(" | ")}`);
  }

  if (!outcome.error) {
    outcome.state = (await exportStateSnapshot(page).catch(() => null)) ?? outcome.state;
  }

  if (download) {
    const file = join(OUT, `${tag}-export.mp4`);
    await download.saveAs(file);
    outcome.file = file;
    const { statSync } = await import("node:fs");
    outcome.bytes = statSync(file).size;
    try {
      const probeOut = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type,codec_name,width,height",
          "-of",
          "json",
          file,
        ],
        { encoding: "utf8" },
      );
      outcome.ffprobe = JSON.parse(probeOut);
    } catch (error) {
      outcome.ffprobe = { error: String(error) };
    }
    const probeJson = outcome.ffprobe as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    const duration = Number(probeJson.format?.duration ?? 0);
    const hasVideo = (probeJson.streams ?? []).some((s) => s.codec_type === "video");
    outcome.ok = outcome.bytes > 10_000 && duration > 0 && hasVideo;
    if (!outcome.ok) {
      outcome.notes.push(
        `exported file failed verification: bytes=${outcome.bytes} duration=${duration} hasVideo=${hasVideo}`,
      );
    }
  } else if (!outcome.error) {
    outcome.error = `no download event within ${EXPORT_TIMEOUT_MS / 60000} min`;
    outcome.notes.push(outcome.error);
  }

  await page.screenshot({ path: join(OUT, "screens", `${tag}-06-export.png`) }).catch(() => {});
  return outcome;
}

// ── playback ─────────────────────────────────────────────────────────────────

interface PlaybackOutcome {
  attempted: boolean;
  ok: boolean;
  timeBefore: string;
  timeAfter: string;
  hashChanged: boolean;
  note: string;
}

async function verifyPlayback(page: Page, tag: string): Promise<PlaybackOutcome> {
  const outcome: PlaybackOutcome = {
    attempted: true,
    ok: false,
    timeBefore: "",
    timeAfter: "",
    hashChanged: false,
    note: "",
  };
  const crypto = await import("node:crypto");
  try {
    let best: ReturnType<Page["locator"]> | null = null;
    let bestArea = 0;
    for (const canvas of await page.locator("canvas").all()) {
      const box = await canvas.boundingBox().catch(() => null);
      if (box && box.width * box.height > bestArea) {
        bestArea = box.width * box.height;
        best = canvas;
      }
    }
    if (!best) {
      outcome.note = "no preview canvas found";
      return outcome;
    }
    const hash = async (name: string): Promise<string> => {
      const buffer = await best!.screenshot({ path: join(OUT, "screens", `${tag}-play-${name}.png`) });
      return crypto.createHash("md5").update(buffer).digest("hex");
    };
    const timeLocator = page.locator("text=/^\\d{2}:\\d{2}:\\d{2} \\/").first();
    outcome.timeBefore = (await timeLocator.innerText().catch(() => "?")) || "?";
    const hashA = await hash("a");
    const play = page.getByRole("button", { name: /^Play$/ }).first();
    await play.click({ timeout: 8000 });
    await page.waitForTimeout(4500);
    outcome.timeAfter = (await timeLocator.innerText().catch(() => "?")) || "?";
    const hashB = await hash("b");
    await page
      .getByRole("button", { name: /^Pause$/ })
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
    outcome.hashChanged = hashA !== hashB;
    outcome.ok =
      outcome.hashChanged ||
      (outcome.timeBefore !== "?" &&
        outcome.timeAfter !== "?" &&
        outcome.timeBefore !== outcome.timeAfter);
    outcome.note = `time ${outcome.timeBefore} -> ${outcome.timeAfter}, frameHashChanged=${outcome.hashChanged}`;
  } catch (error) {
    outcome.note = `playback check errored: ${error instanceof Error ? error.message : String(error)}`;
  }
  return outcome;
}

// ── shared per-run setup ─────────────────────────────────────────────────────

interface SetupResult {
  originalMode: string;
  netlog: NetEntry[];
  consoleLines: string[];
  before: ProjectSnap;
}

async function setupRun(page: Page, tag: string): Promise<SetupResult> {
  const netlog: NetEntry[] = [];
  attachNetworkLog(page, netlog);
  const consoleLines: string[] = [];
  page.on("console", (m) => {
    consoleLines.push(`[${m.type()}] ${m.text()}`);
    if (consoleLines.length > 4000) consoleLines.splice(0, 1000);
  });

  await page.goto("/#new", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  try {
    await page
      .getByRole("button", { name: "Skip Tour" })
      .waitFor({ state: "visible", timeout: 6000 });
    await page.getByRole("button", { name: "Skip Tour" }).click();
  } catch {
    /* no tour */
  }
  await dismissBlockingOverlays(page);
  await openComposer(page);

  const originalMode = (await chatSnapshot(page)).analysisMode;
  log(`[${tag}] original analysis mode: ${originalMode}`);

  // Toggle the real composer chip Eco -> AI and verify the store agrees.
  if ((await chatSnapshot(page)).analysisMode !== "ai") {
    await page.getByRole("button", { name: "Eco", exact: true }).first().click({ timeout: 10000 });
    await expect
      .poll(async () => (await chatSnapshot(page)).analysisMode, { timeout: 10000 })
      .toBe("ai");
  }
  log(`[${tag}] analysis mode is ai`);
  await page.screenshot({ path: join(OUT, "screens", `${tag}-01-ai-mode.png`) });

  // Import the source footage (never the reference).
  await page.locator('input[aria-label="Import media"]').setInputFiles([SRC]);
  await expect
    .poll(
      async () => {
        const snap = await projectSnapshot(page).catch(() => null);
        return snap?.media.filter((m) => /milesmorales/i.test(m.name) && (m.duration ?? 0) > 0)
          .length ?? 0;
      },
      { timeout: 240_000, message: "source video must be imported with metadata" },
    )
    .toBeGreaterThan(0);
  log(`[${tag}] source imported`);

  // Attach the reference and wait for the chip + intent group.
  await page.locator('input[aria-label="Attach reference video"]').setInputFiles(REF);
  await expect
    .poll(async () => (await chatSnapshot(page)).reference?.name ?? "", {
      timeout: 300_000,
      message: "reference attachment must register in the chat store",
    })
    .toContain("SPIDERMAN");
  await page
    .getByRole("group", { name: "Reference intent" })
    .waitFor({ state: "visible", timeout: 60000 });
  log(`[${tag}] reference attached`);
  await page.screenshot({ path: join(OUT, "screens", `${tag}-02-attached.png`) });

  const before = await projectSnapshot(page);
  writeJson(`${tag}-before.json`, before);
  return { originalMode, netlog, consoleLines, before };
}

async function sendPrompt(page: Page, tag: string, prompt: string): Promise<void> {
  await dismissBlockingOverlays(page);
  const composer = page.getByRole("textbox", { name: "AI edit request" });
  await composer.fill(prompt);
  await page.waitForTimeout(500);
  for (let i = 0; i < 10; i++) {
    await page
      .evaluate(() => {
        document
          .querySelectorAll("div.fixed.inset-0")
          .forEach((el) => {
            const cs = getComputedStyle(el);
            if (cs.pointerEvents === "auto" || el.querySelector(".bg-black")) el.remove();
          });
      })
      .catch(() => {});
    try {
      await page.getByRole("button", { name: "Send" }).first().click({ timeout: 4000 });
      log(`[${tag}] SENT: ${prompt}`);
      await page.screenshot({ path: join(OUT, "screens", `${tag}-03-sent.png`) });
      return;
    } catch {
      await page.waitForTimeout(1000);
    }
  }
  throw new Error("could not click Send");
}

// ── verdict assembly ─────────────────────────────────────────────────────────

interface RunResult {
  run: string;
  prompt: string;
  mode: { original: string; during: string; restoredTo: string | null };
  chat: {
    status: string;
    error: string | null;
    usage: { inputTokens: number; outputTokens: number };
    gatewayResponses: { total: number; ok: number; statuses: number[] };
    messages: ChatSnap["messages"];
  };
  vision: {
    analysisModeDuringRun: string;
    extractSegmentsCalled: boolean;
    extractSegmentsSummary: string | null;
    visionWorkerRequests: number;
    localVisionRequests: number;
    verdict: string;
  };
  timeline: {
    beforeClipCount: number;
    afterClipCount: number;
    midClipCount: number | null;
    referenceOnTimeline: boolean;
    offSourceClips: Array<{ clipId: string; mediaId: string; mediaName: string | null }>;
    mirrorProfile: boolean;
    directorPlanRevision: number | null;
  };
  changes: Record<string, unknown>;
  approvals: DriveResult["approvals"];
  playback: PlaybackOutcome | null;
  export: ExportOutcome | null;
  turnTimedOut: boolean;
  events: string[];
  failures: string[];
  verdict: "PASS" | "FAIL";
}

function buildResult(input: {
  run: string;
  prompt: string;
  originalMode: string;
  restoredMode: string | null;
  finalChat: ChatSnap;
  netlog: NetEntry[];
  before: ProjectSnap;
  mid: ProjectSnap | null;
  after: ProjectSnap;
  approvals: DriveResult["approvals"];
  playback: PlaybackOutcome | null;
  exportOutcome: ExportOutcome | null;
  turnTimedOut: boolean;
  events: string[];
}): RunResult {
  const { run, prompt } = input;
  const failures: string[] = [];

  const gateway = input.netlog.filter((e) => e.url.includes("/api/omni/"));
  const gatewayOk = gateway.filter((e) => e.status === 200);
  const visionWorkerRequests = input.netlog.filter(
    (e) => e.url.includes("localhost:8000") || e.url.includes("analyze-frames"),
  ).length;

  const allTools: ToolCallSnap[] = input.finalChat.messages.flatMap((m) => m.toolCalls);
  const extract = allTools.find((t) => t.name === "extract_segments") ?? null;
  let visionVerdict: string;
  if (!extract) {
    visionVerdict =
      "extract_segments was never called by the model in this turn — no AI vision executed";
  } else if (extract.summary && /AI vision didn't work/i.test(extract.summary)) {
    visionVerdict = `PARTIAL: AI vision layer unavailable — local Python analysis engine executed instead. ${extract.summary}`;
  } else if (extract.summary && /vision worker not available/i.test(extract.summary)) {
    visionVerdict =
      "BLOCKED: extract_segments fell back to metadata-only (vision worker and local Python engine both unavailable) — no footage was sent to any analysis engine";
  } else if (extract.summary && /analyzed .*frame\(s\)/i.test(extract.summary)) {
    visionVerdict = `EXECUTED: ${extract.summary}`;
  } else {
    visionVerdict = `UNKNOWN: ${extract.summary ?? "(no summary)"}`;
  }

  const referenceIds = new Set(
    input.after.media
      .filter((m) => m.analysisRole === "reference")
      .map((m) => m.id),
  );
  const sourceIds = new Set(
    input.after.media.filter((m) => m.analysisRole !== "reference").map((m) => m.id),
  );
  const referenceOnTimeline = input.after.clips.some((c) => referenceIds.has(c.mediaId));
  const offSourceClips = input.after.clips
    .filter((c) => !sourceIds.has(c.mediaId))
    .map((c) => ({ clipId: c.id, mediaId: c.mediaId, mediaName: c.mediaName }));

  // Failures — every one of these is a real, observable defect.
  if (input.finalChat.analysisMode !== "ai") {
    failures.push(`analysis mode during run was "${input.finalChat.analysisMode}", expected "ai"`);
  }
  if (gatewayOk.length < 1) {
    failures.push(
      `no successful chat completion through the configured gateway (responses seen: ${gateway.length})`,
    );
  }
  if (input.turnTimedOut) failures.push("the chat turn hit its time budget before finishing");
  if (input.finalChat.status === "error") {
    failures.push(`chat turn ended in error state: ${input.finalChat.error ?? "(no message)"}`);
  }
  if (input.after.clips.length === 0) {
    failures.push("timeline is still empty after the turn");
  }
  if (referenceOnTimeline) {
    failures.push("reference media appears on the timeline (must never happen)");
  }
  if (offSourceClips.length > 0) {
    failures.push(
      `clips reference media outside the source footage: ${JSON.stringify(offSourceClips)}`,
    );
  }
  if (input.after.mirrorProfile !== true) {
    failures.push("reference EditDNA (mirrorProfile) was not attached to the project");
  }
  if (input.playback && !input.playback.ok) {
    failures.push(`playback did not advance: ${input.playback.note}`);
  }
  if (input.exportOutcome && !input.exportOutcome.ok) {
    failures.push(
      `export failed: ${input.exportOutcome.error ?? "unknown"} (${input.exportOutcome.notes.join("; ")})`,
    );
  }

  return {
    run,
    prompt,
    mode: {
      original: input.originalMode,
      during: input.finalChat.analysisMode,
      restoredTo: input.restoredMode,
    },
    chat: {
      status: input.finalChat.status,
      error: input.finalChat.error,
      usage: input.finalChat.usage,
      gatewayResponses: {
        total: gateway.length,
        ok: gatewayOk.length,
        statuses: [...new Set(gateway.map((e) => e.status ?? -1))],
      },
      messages: input.finalChat.messages,
    },
    vision: {
      analysisModeDuringRun: input.finalChat.analysisMode,
      extractSegmentsCalled: !!extract,
      extractSegmentsSummary: extract?.summary ?? null,
      visionWorkerRequests,
      localVisionRequests: input.netlog.filter((e) => e.url.includes("localhost:8000")).length,
      verdict: visionVerdict,
    },
    timeline: {
      beforeClipCount: input.before.clips.length,
      afterClipCount: input.after.clips.length,
      midClipCount: input.mid?.clips.length ?? null,
      referenceOnTimeline,
      offSourceClips,
      mirrorProfile: input.after.mirrorProfile,
      directorPlanRevision: input.after.directorPlanRevision,
    },
    changes: classifyChanges(input.before, input.after),
    approvals: input.approvals,
    playback: input.playback,
    export: input.exportOutcome,
    turnTimedOut: input.turnTimedOut,
    events: input.events,
    failures,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
  };
}

// ── the two runs ─────────────────────────────────────────────────────────────

test.describe("reference flow in AI mode (real browser, real chat)", () => {
  test.skip(!hasBrowser(), "No Chromium available: set KOVE_E2E_CHROMIUM.");

  test("/reference: style-guided edit from the source footage", async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const tag = "reference";
    const prompt =
      "/reference make an edit in this style, keeping the source footage's story and content";

    let originalMode = "eco";
    let restoredMode: string | null = null;
    let netlog: NetEntry[] = [];
    let consoleLines: string[] = [];
    let setup: SetupResult | null = null;
    let drive: DriveResult | null = null;
    let before: ProjectSnap | null = null;
    let after: ProjectSnap | null = null;
    let playback: PlaybackOutcome | null = null;
    let exportOutcome: ExportOutcome | null = null;
    let finalChat: ChatSnap | null = null;

    try {
      setup = await setupRun(page, tag);
      originalMode = setup.originalMode;
      netlog = setup.netlog;
      consoleLines = setup.consoleLines;
      before = setup.before;

      await sendPrompt(page, tag, prompt);
      drive = await driveTurn(page, tag);

      finalChat = drive.finalChat;
      after = await projectSnapshot(page);
      writeJson(`${tag}-after.json`, after);
      writeJson(`${tag}-chat.json`, drive.finalChat);
      writeFileSync(join(OUT, `${tag}-events.txt`), `${drive.events.join("\n")}\n`);
      await page.screenshot({ path: join(OUT, "screens", `${tag}-05-after-edit.png`) });

      if (after.clips.length > 0) {
        playback = await verifyPlayback(page, tag);
        writeJson(`${tag}-playback.json`, playback);
        exportOutcome = await runExport(page, tag);
        writeJson(`${tag}-export.json`, exportOutcome);
      } else {
        exportOutcome = {
          attempted: false,
          ok: false,
          file: null,
          bytes: null,
          ffprobe: null,
          state: null,
          error: "skipped: timeline empty",
          fsaPickerPresent: false,
          fsaPickerRemoved: false,
          notes: ["export skipped because the timeline stayed empty"],
        };
        writeJson(`${tag}-export.json`, exportOutcome);
      }
    } finally {
      // Restore the original analysis mode, per run contract.
      try {
        const current = await chatSnapshot(page);
        if (current.analysisMode !== originalMode) {
          await page.evaluate(async (mode) => {
            const src = await (await fetch("/src/components/editor/chat/ChatPanel.tsx")).text();
            const match = [...src.matchAll(/from\s+"([^"]*chat-store[^"]*)"/g)][0];
            const cs = await import(match[1] as string);
            cs.useChatStore.getState().setAnalysisMode(mode);
          }, originalMode);
        }
        restoredMode = (await chatSnapshot(page)).analysisMode;
      } catch (error) {
        restoredMode = `restore failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      writeJson(`${tag}-netlog.json`, netlog);
      writeJson(`${tag}-console.json`, consoleLines);
      log(`[${tag}] mode restored to ${restoredMode}`);
    }

    expect(before, "before-snapshot must exist").toBeTruthy();
    expect(finalChat, "chat snapshot must exist").toBeTruthy();

    const result = buildResult({
      run: tag,
      prompt,
      originalMode,
      restoredMode,
      finalChat: finalChat!,
      netlog,
      before: before!,
      mid: drive?.midSnapshot ?? null,
      after: after!,
      approvals: drive?.approvals ?? [],
      playback,
      exportOutcome,
      turnTimedOut: drive?.timedOut ?? false,
      events: drive?.events ?? [],
    });
    writeJson(`${tag}-result.json`, result);
    log(`[${tag}] verdict: ${result.verdict}; vision: ${result.vision.verdict}`);
    expect(result.failures, JSON.stringify({ verdict: result.verdict, failures: result.failures }, null, 2)).toEqual([]);
  });

  test("/mirror: rebuild source to the reference structure", async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const tag = "mirror";
    const prompt = "/mirror recreate this style using my source footage";

    let originalMode = "eco";
    let restoredMode: string | null = null;
    let netlog: NetEntry[] = [];
    let consoleLines: string[] = [];
    let setup: SetupResult | null = null;
    let drive: DriveResult | null = null;
    let before: ProjectSnap | null = null;
    let after: ProjectSnap | null = null;
    let playback: PlaybackOutcome | null = null;
    let exportOutcome: ExportOutcome | null = null;
    let finalChat: ChatSnap | null = null;

    try {
      setup = await setupRun(page, tag);
      originalMode = setup.originalMode;
      netlog = setup.netlog;
      consoleLines = setup.consoleLines;
      before = setup.before;

      await sendPrompt(page, tag, prompt);
      drive = await driveTurn(page, tag);

      finalChat = drive.finalChat;
      after = await projectSnapshot(page);
      writeJson(`${tag}-after.json`, after);
      writeJson(`${tag}-chat.json`, drive.finalChat);
      writeFileSync(join(OUT, `${tag}-events.txt`), `${drive.events.join("\n")}\n`);
      await page.screenshot({ path: join(OUT, "screens", `${tag}-05-after-edit.png`) });

      if (after.clips.length > 0) {
        playback = await verifyPlayback(page, tag);
        writeJson(`${tag}-playback.json`, playback);
        exportOutcome = await runExport(page, tag);
        writeJson(`${tag}-export.json`, exportOutcome);
      } else {
        exportOutcome = {
          attempted: false,
          ok: false,
          file: null,
          bytes: null,
          ffprobe: null,
          state: null,
          error: "skipped: timeline empty",
          fsaPickerPresent: false,
          fsaPickerRemoved: false,
          notes: ["export skipped because the timeline stayed empty"],
        };
        writeJson(`${tag}-export.json`, exportOutcome);
      }
    } finally {
      try {
        const current = await chatSnapshot(page);
        if (current.analysisMode !== originalMode) {
          await page.evaluate(async (mode) => {
            const src = await (await fetch("/src/components/editor/chat/ChatPanel.tsx")).text();
            const match = [...src.matchAll(/from\s+"([^"]*chat-store[^"]*)"/g)][0];
            const cs = await import(match[1] as string);
            cs.useChatStore.getState().setAnalysisMode(mode);
          }, originalMode);
        }
        restoredMode = (await chatSnapshot(page)).analysisMode;
      } catch (error) {
        restoredMode = `restore failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      writeJson(`${tag}-netlog.json`, netlog);
      writeJson(`${tag}-console.json`, consoleLines);
      log(`[${tag}] mode restored to ${restoredMode}`);
    }

    expect(before, "before-snapshot must exist").toBeTruthy();
    expect(finalChat, "chat snapshot must exist").toBeTruthy();

    const result = buildResult({
      run: tag,
      prompt,
      originalMode,
      restoredMode,
      finalChat: finalChat!,
      netlog,
      before: before!,
      mid: drive?.midSnapshot ?? null,
      after: after!,
      approvals: drive?.approvals ?? [],
      playback,
      exportOutcome,
      turnTimedOut: drive?.timedOut ?? false,
      events: drive?.events ?? [],
    });
    writeJson(`${tag}-result.json`, result);
    log(`[${tag}] verdict: ${result.verdict}; vision: ${result.vision.verdict}`);
    expect(result.failures, JSON.stringify({ verdict: result.verdict, failures: result.failures }, null, 2)).toEqual([]);
  });
});
