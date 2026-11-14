import { execFileSync, spawnSync } from "node:child_process";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

/** Model responses are deliberately stubbed; editor, chat, director tools and
 * timeline are real. This tests recovery behavior, not a live AI provider. */
const ffmpeg = process.env.KOVE_E2E_FFMPEG ?? "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
test.skip(!hasBrowser() || !hasFfmpeg, "Chromium and ffmpeg are required");
test.setTimeout(120_000);

async function prepare(page: Page, testInfo: TestInfo): Promise<string> {
  await page.addInitScript(() => {
    // The editor loads hundreds of modules; preserve their actual Vite URLs
    // (including HMR query strings) so test imports share the app's stores.
    performance.setResourceTimingBufferSize(10_000);
    localStorage.setItem("kove-advanced-onboarding-complete", "true");
    localStorage.setItem("kove-advanced-mograph-tour-complete", "true");
  });
  await page.goto("/#new", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import Media" }).first().waitFor({ timeout: 90_000 });
  const source = testInfo.outputPath("director-source.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=4", "-t", "2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", source]);
  await page.locator('input[aria-label="Import media"]').setInputFiles(source);
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/stores/project-store.ts";
    const url = performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === path).at(-1)?.name ?? path;
    const { useProjectStore } = await import(/* @vite-ignore */ url);
    return useProjectStore.getState().project.mediaLibrary.items.some((item) => item.name === "director-source.mp4");
  }), { timeout: 90_000 }).toBe(true);
  return page.evaluate(async () => {
    const storePath = "/src/stores/project-store.ts";
    const settingsPath = "/src/stores/settings-store.ts";
    const find = (path: string) => performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === path).at(-1)?.name ?? path;
    const { useProjectStore } = await import(/* @vite-ignore */ find(storePath));
    const { useSettingsStore } = await import(/* @vite-ignore */ find(settingsPath));
    useSettingsStore.setState({
      defaultLlmProvider: "openai-compatible",
      llmBaseUrl: "https://stub-director.invalid/v1",
      llmModel: "stub-director",
      configuredServices: [],
      agentAutoConfirm: true,
      agentDryRun: false,
    });
    return useProjectStore.getState().project.mediaLibrary.items.find((item) => item.name === "director-source.mp4")!.id;
  });
}

async function chatSnapshot(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/stores/chat-store.ts";
    const url = performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === path).at(-1)?.name ?? path;
    const state = (await import(/* @vite-ignore */ url)).useChatStore.getState();
    return { status: state.status, error: state.error, committed: state.lastTurnCommitted, messages: state.messages };
  });
}

async function timeline(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/stores/project-store.ts";
    const url = performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname === path).at(-1)?.name ?? path;
    return (await import(/* @vite-ignore */ url)).useProjectStore.getState().project.timeline.tracks.flatMap((track) => track.clips);
  });
}

function textResponse(text: string) {
  return { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] };
}
function toolResponse(name: string, args: unknown, id: string) {
  return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] };
}

async function send(page: Page) {
  await page.getByRole("textbox", { name: "AI edit request" }).fill("Create a highlight reel from the source video.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

test("surfaces an empty timeline after one retry instead of claiming success (stub model)", async ({ page }, testInfo) => {
  await prepare(page, testInfo);
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  await page.route("https://stub-director.invalid/v1/chat/completions", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type" } });
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, json: textResponse("The edit is ready.") });
  });
  await send(page);
  await expect.poll(async () => (await chatSnapshot(page)).status, { timeout: 60_000 }).toBe("error");
  const chat = await chatSnapshot(page);
  expect(chat.error).toContain("timeline is still empty");
  expect(chat.committed).toBe(false);
  expect(await timeline(page)).toHaveLength(0);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.find((message) => message.role === "system")?.content).toContain("timeline is still empty");
  await expect(page.getByText(/Monet did not create an edit/).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("empty-director-error.png") });
});

test("retry can invoke the real plan tool and put source clips on the timeline (stub model)", async ({ page }, testInfo) => {
  const sourceId = await prepare(page, testInfo);
  // Headless CI has no local Python analyzer listening; the frame-analysis
  // HTTP call the director makes (local-analyzer POST /analyze-frames) is
  // stubbed to a sync VisionWorker-shaped payload. Frame extraction itself
  // runs for real in the page; only the vision service is substituted.
  const analysisBodies: unknown[] = [];
  await page.route("http://localhost:8000/**", async (route) => {
    if (route.request().method() === "POST" && route.request().url().includes("/analyze-frames")) {
      analysisBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          batches: [
            {
              descriptions: [
                { timestamp: 0, description: "A solid blue test frame.", sceneType: "b-roll", motionLevel: "low", hasDialogue: false, confidence: 0.9 },
                { timestamp: 1, description: "A solid blue test frame.", sceneType: "b-roll", motionLevel: "low", hasDialogue: false, confidence: 0.9 },
              ],
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const plan = {
    segments: [{ sourceVideoId: sourceId, sourceStartTime: 0, sourceEndTime: 1, trackIndex: 0, targetPosition: 0, effects: [], effectSpecs: [], rationale: "Use the source clip" }],
    textElements: [], effects: [], transitions: [], audioDecisions: [],
    metadata: { targetDuration: 1, targetPlatform: "social", genre: "highlight-reel", pacing: "fast", rationale: "Test edit" },
  };
  let outerCalls = 0;
  let planCalls = 0;
  let extractCalls = 0;
  await page.route("https://stub-director.invalid/v1/chat/completions", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type" } });
    const body = route.request().postDataJSON() as { tools?: Array<{ function?: { name?: string } }> };
    const innerPlan = body.tools?.some((tool) => tool.function?.name === "submit_edit_plan");
    // NOTE: plan_edit also issues a nested `expand_prompt_result` completion
    // (brief expansion). A plain-text answer is fine — the expansion helper
    // then falls back to question-based expansion without calling the model
    // again. Do NOT return an expand_prompt_result tool call here: the
    // structured-output-only tool cannot execute, and the outer loop would
    // retry it until the tool-call budget is exhausted.
    let result;
    if (innerPlan) {
      planCalls++;
      result = toolResponse("submit_edit_plan", { ...plan, segments: [{ ...plan.segments[0], sourceVideoId: sourceId }] }, `inner-${planCalls}`);
    } else {
      // The director contract: a fresh footage edit may not be planned from
      // filename/duration guesses — the model must run frame analysis first.
      // Script that path (text claim → retry → extract_segments → plan_edit),
      // plus the plan tool's own expand_prompt_result pre-step.
      outerCalls++;
      result =
        outerCalls === 1 ? textResponse("The edit is ready.")
        : outerCalls === 2 ? toolResponse("extract_segments", {}, "outer-extract")
        : outerCalls === 3 ? toolResponse("plan_edit", { prompt: "Create a highlight using the source" }, "outer-plan")
        : textResponse("The source clip is on the timeline.");
      if (outerCalls === 2) extractCalls++;
    }
    await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, json: result });
  });
  await send(page);
  await expect.poll(async () => (await chatSnapshot(page)).committed, { timeout: 90_000 }).toBe(true);
  const clips = await timeline(page);
  expect(clips).toHaveLength(1);
  expect(clips[0].mediaId).toBe(sourceId);
  // 1: opening text claim → 2: extract_segments → 3: plan_edit →
  // 4: plan_edit's nested expand_prompt_result pre-step (answered with
  //    plain text) → 5: final text after the plan is applied.
  expect(outerCalls).toBe(5);
  expect(extractCalls).toBe(1);
  expect(planCalls).toBeGreaterThan(0);
  // The director grounded its plan in real frame analysis: frames were
  // captured in the page and shipped to the (stubbed) vision endpoint.
  expect(analysisBodies).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("director-timeline.png") });
});
