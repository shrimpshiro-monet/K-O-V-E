import { execFileSync, spawnSync } from "node:child_process";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

/**
 * Manual editing × AI director handoff — the suite a user runs before shipping.
 *
 * Every test drives the real editor the way a user does: import footage, put it
 * on the timeline, scrub the ruler, split with the keyboard, double-click
 * effect cards, click "Add Title". It then hands the session to the AI through
 * the same chat a user sees (real Send button, real provider loop, real tool
 * execution, real project mutations) with only the provider itself stubbed —
 * and asserts the AI lands its edits exactly where the user was pointing:
 *
 *   - the playhead the user scrubbed to, and
 *   - the clip / text clip / effect the user selected or created by hand.
 *
 * This is the regression net for the failure mode where manual edits left the
 * AI blind to the user's screen (it had no playhead or selection to aim at),
 * so "add a title here" produced an edit somewhere else, or failed outright.
 *
 * The stub provider parses the *system prompt of its own request* for the
 * editor-context block (`playheadSec`, `selected: type=clip id="…"`, effect
 * ids). If the context ever stops flowing, the stub records a parse error and
 * the test fails with the prompt in the message — no silent passes.
 */
const ffmpeg = process.env.KOVE_E2E_FFMPEG ?? "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
test.skip(!hasBrowser() || !hasFfmpeg, "Chromium and ffmpeg are required");
test.setTimeout(180_000);

const STUB_ORIGIN = "https://stub-editor.invalid";

/** Store modules are imported by the URL the app booted with — the dev server
 * serves HMR-invalidated modules with a `?t=<timestamp>` query, and a plain
 * path import would create a detached second instance of the store (the test
 * would then read state the app never touches). */

function corsPreflight(route: Parameters<Parameters<Page["route"]>[1]>[0]): Promise<void> | void {
  if (route.request().method() !== "OPTIONS") return;
  return route.fulfill({
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function textResponse(text: string) {
  return {
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
  };
}

function toolResponse(
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call, index) => ({
            id: `stub-call-${index + 1}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

interface CapturedRequest {
  messages?: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> | null }>;
  tools?: Array<{ function?: { name?: string } }>;
  parseError?: string;
}

function messageText(message: {
  content?: string | Array<{ type: string; text?: string }> | null;
}): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text ?? "").join("\n");
  }
  return "";
}

function systemOf(body: CapturedRequest): string {
  const system = (body.messages ?? []).find((message) => message.role === "system");
  return system ? messageText(system) : "";
}

function toolNamesOf(body: CapturedRequest): string[] {
  return (body.tools ?? [])
    .map((tool) => tool.function?.name ?? "")
    .filter((name) => name.length > 0);
}

function hasToolResult(body: CapturedRequest): boolean {
  return (body.messages ?? []).some((message) => message.role === "tool");
}


/** Makes the provider one deterministic scripted responder per request. */
type StubBehavior = (
  body: CapturedRequest,
  systemPrompt: string,
) =>
  | { kind: "tools"; calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }> }
  | { kind: "text"; text: string }
  | { kind: "parse-error"; detail: string };

async function installStubProvider(
  page: Page,
  captured: CapturedRequest[],
  behavior: StubBehavior,
): Promise<void> {
  await page.route(`${STUB_ORIGIN}/v1/chat/completions`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return corsPreflight(route);
    }
    const body = route.request().postDataJSON() as CapturedRequest;
    captured.push(body);
    const response = behavior(body, systemOf(body));
    const json =
      response.kind === "tools"
        ? toolResponse(response.calls)
        : response.kind === "text"
          ? textResponse(response.text)
          : textResponse(`STUB PARSE FAILURE: ${response.detail}`);
    if (response.kind === "parse-error") {
      body.parseError = response.detail;
    }
    await route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      json,
    });
  });
}

async function createFixtureVideo(testInfo: TestInfo): Promise<string> {
  const source = testInfo.outputPath("manual-fixture.mp4");
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  return source;
}

/**
 * Boots a fresh editor project, imports the fixture and drops it on the
 * timeline — exactly what a user does first.
 */
async function prepareEditor(page: Page, testInfo: TestInfo): Promise<void> {
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(10_000);
    localStorage.setItem("kove-advanced-onboarding-complete", "true");
    localStorage.setItem("kove-advanced-mograph-tour-complete", "true");
  });
  await page.goto("/#new", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import Media" }).first().waitFor({ timeout: 90_000 });

  const source = await createFixtureVideo(testInfo);
  // Import through the real file chooser a user's click opens — never set
  // files on the hidden input directly (it can race a React re-render and
  // the change event never reaches the app).
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 30_000 });
  await page.locator('button[aria-label="Import media"]').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(source);

  // The import is done when the media tile shows up — the same signal a user sees.
  const tile = page.locator('img[alt$="manual-fixture.mp4"]').first();
  await expect(tile).toBeVisible({ timeout: 120_000 });
  await tile.hover();
  await page.getByRole("button", { name: "Add to timeline" }).first().click();

  // The first clip into an empty project asks whether to adopt the video's
  // dimensions; keep the project's own 16:9 like a user would.
  const keepCurrent = page.getByRole("button", { name: "Keep Current" });
  await expect(keepCurrent).toBeVisible();
  await keepCurrent.click();

  // The clip lands on the timeline — wait for the user-visible handle.
  await expect(page.getByRole("button", { name: /Select clip / }).first()).toBeVisible({
    timeout: 30_000,
  });

  await configureStubProvider(page);
}

/** Point the AI at the stub provider, exactly as a user would in Settings. */
async function configureStubProvider(page: Page): Promise<void> {
  await page.evaluate(async (origin: string) => {
    const { useSettingsStore } = await import(
      /* @vite-ignore */
      performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/src/stores/settings-store.ts").at(-1)?.name ?? "/src/stores/settings-store.ts",
    );
    useSettingsStore.setState({
      defaultLlmProvider: "openai-compatible",
      llmBaseUrl: `${origin}/v1`,
      llmModel: "stub-editor",
      configuredServices: [],
      agentAutoConfirm: true,
      agentDryRun: false,
    });
  }, STUB_ORIGIN);
}

/** Move the playhead by clicking the ruler — the interaction a user scrubs with. */
async function scrubTo(page: Page, seconds: number): Promise<void> {
  const ruler = page.getByTestId("timeline-ruler");
  await ruler.waitFor({ state: "visible", timeout: 30_000 });
  const geometry = await ruler.evaluate((element) => {
    const viewport = element.parentElement?.parentElement;
    if (!viewport) throw new Error("ruler viewport not found");
    const rect = viewport.getBoundingClientRect();
    const rulerRect = element.getBoundingClientRect();
    return {
      viewportLeft: rect.left,
      viewportWidth: rect.width,
      rulerTop: rulerRect.top + rulerRect.height / 2,
    };
  });
  const pixelsPerSecond = await page.evaluate(async () => {
    const { useTimelineStore } = await import(
      /* @vite-ignore */
      performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/src/stores/timeline-store.ts").at(-1)?.name ?? "/src/stores/timeline-store.ts",
    );
    return useTimelineStore.getState().pixelsPerSecond;
  });
  const x = geometry.viewportLeft + seconds * pixelsPerSecond;
  expect(x).toBeLessThan(geometry.viewportLeft + geometry.viewportWidth);
  await page.mouse.click(x, geometry.rulerTop);
}

/** The timeline model as the editor itself sees it. */
async function projectState(page: Page) {
  return page.evaluate(async () => {
    const { useProjectStore } = await import(
      /* @vite-ignore */
      performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/src/stores/project-store.ts").at(-1)?.name ?? "/src/stores/project-store.ts",
    );
    const project = useProjectStore.getState().project;
    return {
      tracks: project.timeline.tracks.map((track, trackIndex) => ({
        id: track.id,
        trackIndex,
        type: track.type,
        name: track.name,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          mediaId: clip.mediaId,
          start: clip.startTime,
          duration: clip.duration,
          effects: (clip.effects ?? []).map((effect) => ({
            id: effect.id,
            type: effect.type,
            enabled: effect.enabled,
          })),
        })),
      })),
      textClips: (project.textClips ?? []).map((text) => ({
        id: text.id,
        trackId: text.trackId,
        text: text.text,
        start: text.startTime,
        duration: text.duration,
        effects: (text.effects ?? []).map((effect) => ({
          id: effect.id,
          type: effect.type,
          enabled: effect.enabled,
        })),
      })),
    };
  });
}

async function timelinePlayhead(page: Page): Promise<number> {
  const raw = await page.locator("[data-timeline-view]").getAttribute("data-playhead-sec");
  return Number(raw);
}

async function selectTimelineClip(page: Page, index: number): Promise<void> {
  const clips = page.getByRole("button", { name: /Select clip / });
  await clips.nth(index).click();
}

async function selectedClipIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { useUIStore } = await import(
      /* @vite-ignore */
      performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/src/stores/ui-store.ts").at(-1)?.name ?? "/src/stores/ui-store.ts",
    );
    return useUIStore.getState().selectedItems.map((item) => item.id);
  });
}

async function openAssetsTab(page: Page, label: string): Promise<void> {
  const categories = page.locator('[aria-label="Asset categories"]');
  await categories.getByRole("button", { name: label, exact: true }).click();
}

async function sendAiMessage(page: Page, message: string): Promise<void> {
  await page.getByRole("textbox", { name: "AI edit request" }).fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function chatSnapshot(page: Page) {
  return page.evaluate(async () => {
    const { useChatStore } = await import(
      /* @vite-ignore */
      performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === "/src/stores/chat-store.ts").at(-1)?.name ?? "/src/stores/chat-store.ts",
    );
    const state = useChatStore.getState();
    return { status: state.status, error: state.error, committed: state.lastTurnCommitted };
  });
}

async function waitForCommittedTurn(page: Page, captured: CapturedRequest[]): Promise<void> {
  await expect
    .poll(
      async () => (await chatSnapshot(page)).status,
      { timeout: 120_000, message: "the AI turn should finish" },
    )
    .not.toBe("running");
  const snapshot = await chatSnapshot(page);
  const parseFailures = captured.filter((body) => body.parseError).map((body) => body.parseError);
  expect(
    parseFailures,
    `the stub could not read the editor context from the system prompt — the AI was flying blind:\n${parseFailures.join("\n")}`,
  ).toEqual([]);
  expect(snapshot.error, `AI turn errored: ${snapshot.error ?? "unknown"}`).toBeNull();
  expect(snapshot.committed).toBe(true);
}

test("user scrubs and splits with the keyboard; the AI edits the clip the user selected", async ({ page }, testInfo) => {
  await prepareEditor(page, testInfo);
  const captured: CapturedRequest[] = [];
  await installStubProvider(page, captured, (body, system) => {
    if (hasToolResult(body)) {
      return { kind: "text", text: "Added brightness to the clip you selected." };
    }
    const clipId = /selected: type=clip id="([^"]+)"/.exec(system)?.[1];
    if (!clipId) {
      return { kind: "parse-error", detail: "no `selected: type=clip id=...` line in system prompt" };
    }
    return {
      kind: "tools",
      calls: [{ name: "add_video_effect", args: { clipId, effectType: "brightness" } }],
    };
  });

  // The user scrubs the playhead to 2.0s, then selects the clip (clicking the
  // ruler clears any selection — a user scrubs first, then picks the clip).
  await scrubTo(page, 2.0);
  expect(await timelinePlayhead(page)).toBeCloseTo(2.0, 1);
  await selectTimelineClip(page, 0);

  // Split at the playhead with the keyboard, as a user would (S).
  await page.keyboard.press("s");
  await expect
    .poll(async () => (await projectState(page)).tracks.flatMap((t) => t.clips).length)
    .toBe(2);
  const afterSplit = await projectState(page);
  const clips = afterSplit.tracks[0].clips;
  expect(clips[0].start).toBeCloseTo(0, 3);
  expect(clips[0].duration).toBeCloseTo(2.0, 3);
  expect(clips[1].start).toBeCloseTo(2.0, 3);
  expect(clips[1].duration).toBeCloseTo(4.0, 3);
  const originalId = clips[0].id;
  const tailId = clips[1].id;
  expect(tailId).not.toBe(originalId);

  // The user clicks the *second* half of the split, then asks the AI for an effect.
  await selectTimelineClip(page, 1);
  expect(await selectedClipIds(page)).toEqual([tailId]);

  await sendAiMessage(page, "Add a brightness effect to the selected clip.");
  await waitForCommittedTurn(page, captured);

  // The AI must see (and target) the clip the user just selected — the new
  // split segment — not the pre-split clip or a guessed id.
  expect(captured.length).toBeGreaterThan(0);
  const firstRequest = captured[0];
  const firstSystem = systemOf(firstRequest);
  expect(firstSystem).toContain(`selected: type=clip id="${tailId}"`);
  expect(firstSystem).toContain("playheadSec: 2.000");
  expect(toolNamesOf(firstRequest)).toContain("add_video_effect");

  const afterEffect = await projectState(page);
  const [head, tail] = afterEffect.tracks[0].clips;
  expect(head.effects, "the first segment must stay untouched").toHaveLength(0);
  expect(tail.effects).toHaveLength(1);
  expect(tail.effects[0].type).toBe("brightness");
});

test("user scrubs to 2.5s; \"add a title right here\" lands the title exactly at the playhead", async ({
  page,
}, testInfo) => {
  await prepareEditor(page, testInfo);
  const captured: CapturedRequest[] = [];
  await installStubProvider(page, captured, (body, system) => {
    if (hasToolResult(body)) {
      return { kind: "text", text: "Done — the title is at your playhead." };
    }
    const playhead = /playheadSec:\s*([0-9.]+)/.exec(system)?.[1];
    if (!playhead) {
      return { kind: "parse-error", detail: "no `playheadSec:` line in system prompt" };
    }
    return {
      kind: "tools",
      calls: [
        {
          name: "create_text_clip",
          args: { clip: { text: "MARKER ZERO", startTime: Number(playhead), duration: 2 } },
        },
      ],
    };
  });

  await scrubTo(page, 2.5);
  expect(await timelinePlayhead(page)).toBeCloseTo(2.5, 1);

  await sendAiMessage(page, "Add a title that says 'MARKER ZERO' right here.");
  await waitForCommittedTurn(page, captured);

  expect(systemOf(captured[0])).toContain("playheadSec: 2.500");
  expect(toolNamesOf(captured[0])).toContain("create_text_clip");

  const state = await projectState(page);
  expect(state.textClips).toHaveLength(1);
  expect(state.textClips[0].text).toBe("MARKER ZERO");
  expect(state.textClips[0].start).toBeCloseTo(2.5, 2);
  expect(state.textClips[0].duration).toBeCloseTo(2.0, 3);

  // The timeline reflects it too, not just the model.
  await expect(page.getByRole("button", { name: /Select text clip MARKER ZERO/ })).toBeVisible();
});

test("user adds a Brightness effect by hand; the AI disables that exact effect", async ({ page }, testInfo) => {
  await prepareEditor(page, testInfo);
  const captured: CapturedRequest[] = [];

  // Manual action: select the clip, open Effects, double-click the card.
  await selectTimelineClip(page, 0);
  await openAssetsTab(page, "Effects");
  await page.getByRole("button", { name: /^Brightness\./ }).dblclick();
  await expect
    .poll(async () => (await projectState(page)).tracks[0].clips[0].effects.length)
    .toBe(1);
  const manualEffectId = (await projectState(page)).tracks[0].clips[0].effects[0].id;

  await installStubProvider(page, captured, (body, system) => {
    if (hasToolResult(body)) {
      return { kind: "text", text: "Brightness is off." };
    }
    const clipId = /selected: type=clip id="([^"]+)"/.exec(system)?.[1];
    const effectId = /\{id="([^"]+)" type=brightness/.exec(system)?.[1];
    if (!clipId || !effectId) {
      return {
        kind: "parse-error",
        detail: `could not parse selection (${clipId ? "ok" : "missing clip"}) / brightness effect (${effectId ? "ok" : "missing"})`,
      };
    }
    if (effectId !== manualEffectId) {
      return { kind: "parse-error", detail: `stub parsed ${effectId}, user created ${manualEffectId}` };
    }
    return {
      kind: "tools",
      calls: [
        {
          name: "toggle_video_effect",
          args: { clipId, effectId, enabled: false },
        },
      ],
    };
  });

  await sendAiMessage(page, "Turn off the brightness effect I just added.");
  await waitForCommittedTurn(page, captured);

  const state = await projectState(page);
  const effect = state.tracks[0].clips[0].effects.find((entry) => entry.id === manualEffectId);
  expect(effect, "the AI must toggle the user's effect, not create a new one").toBeDefined();
  expect(effect?.enabled).toBe(false);
});

test("user adds a title by hand; the AI rewrites the text of that exact title", async ({ page }, testInfo) => {
  await prepareEditor(page, testInfo);
  const captured: CapturedRequest[] = [];

  // Manual action: scrub to 1.5s, Text tab, Add Title.
  await scrubTo(page, 1.5);
  await openAssetsTab(page, "Text");
  await page.getByRole("button", { name: "Add Title", exact: true }).click();
  await expect.poll(async () => (await projectState(page)).textClips.length).toBe(1);
  const manualTitle = (await projectState(page)).textClips[0];
  expect(manualTitle.text).toBe("New Title");
  expect(manualTitle.start).toBeCloseTo(1.5, 2);

  // The user clicks the title to select it, then asks the AI for a rewrite.
  await page.getByRole("button", { name: /Select text clip New Title/ }).click();
  expect(await selectedClipIds(page)).toEqual([manualTitle.id]);

  await installStubProvider(page, captured, (body, system) => {
    if (hasToolResult(body)) {
      return { kind: "text", text: "Title updated." };
    }
    const clipId = /selected: type=text-clip id="([^"]+)"/.exec(system)?.[1];
    if (!clipId) {
      return { kind: "parse-error", detail: "no `selected: type=text-clip id=...` line in system prompt" };
    }
    if (clipId !== manualTitle.id) {
      return { kind: "parse-error", detail: `stub parsed ${clipId}, user created ${manualTitle.id}` };
    }
    return {
      kind: "tools",
      calls: [
        {
          name: "update_text_clip",
          args: { clipId, updates: { text: "REBRANDED BY AI" } },
        },
      ],
    };
  });

  await sendAiMessage(page, "Change that title to say 'REBRANDED BY AI'.");
  await waitForCommittedTurn(page, captured);

  const state = await projectState(page);
  expect(state.textClips).toHaveLength(1);
  expect(state.textClips[0].id).toBe(manualTitle.id);
  expect(state.textClips[0].text).toBe("REBRANDED BY AI");
});

test("manual split, AI turn, undo twice, redo once - history stays coherent", async ({ page }, testInfo) => {
  await prepareEditor(page, testInfo);
  const captured: CapturedRequest[] = [];
  await installStubProvider(page, captured, (body, system) => {
    if (hasToolResult(body)) {
      return { kind: "text", text: "Title added at your playhead." };
    }
    const playhead = /playheadSec:\s*([0-9.]+)/.exec(system)?.[1];
    if (!playhead) {
      return { kind: "parse-error", detail: "no `playheadSec:` line in system prompt" };
    }
    return {
      kind: "tools",
      calls: [
        {
          name: "create_text_clip",
          args: { clip: { text: "AI TITLE", startTime: Number(playhead), duration: 2 } },
        },
      ],
    };
  });

  // Manual: scrub to 2.0, select the clip, split with the keyboard.
  await scrubTo(page, 2.0);
  await selectTimelineClip(page, 0);
  await page.keyboard.press("s");
  await expect
    .poll(async () => (await projectState(page)).tracks.flatMap((t) => t.clips).length)
    .toBe(2);

  // Scrub back to 1.0 and ask the AI for a title here.
  await scrubTo(page, 1.0);
  await sendAiMessage(page, "Add a title that says 'AI TITLE' right here.");
  await waitForCommittedTurn(page, captured);

  let state = await projectState(page);
  expect(state.textClips).toHaveLength(1);
  expect(state.textClips[0].start).toBeCloseTo(1.0, 2);

  // Click out of the chat box (so the shortcut isn't swallowed by the
  // composer), then undo twice: the AI's turn first, then the manual split.
  await page.locator("[data-timeline-view]").click({ position: { x: 10, y: 200 }, force: true });
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await projectState(page)).textClips.length).toBe(0);
  expect((await projectState(page)).tracks.flatMap((t) => t.clips)).toHaveLength(2);

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await projectState(page)).tracks.flatMap((t) => t.clips).length)
    .toBe(1);

  // Redo the split; the AI turn must not be resurrected (it was undone after it).
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(async () => (await projectState(page)).tracks.flatMap((t) => t.clips).length)
    .toBe(2);
  expect((await projectState(page)).textClips).toHaveLength(0);
});
