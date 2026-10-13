// Scripted "Monet" brain for the Playwright E2E demo (no external creds needed).
// Serves non-streaming OpenAI-compatible /v1/chat/completions on 127.0.0.1:8799.
//
// Protocol — conversation-shape, keyed on the SPECIFIC tools (stateless,
// restart-proof, safe for back-to-back runs):
//   * director sub-turn (sys contains "## Available audio" /
//     "Canonical sourceVideoId"): first sighting -> submit_edit_plan(THE_PLAN);
//     if history already contains that call -> keep-text ("Plan stands").
//   * outer agent loop: unless history already contains a plan_edit call or
//     result -> tool_call plan_edit(BRIEF); else -> final assistant text.
// (The outer loop pre-executes grounding tools before the first complete(),
// so "any tool result exists" is NOT a progress marker — keyed tool names are.)
import { createServer } from "node:http";

const PORT = 8799;

const BRIEF =
  "Cut a 14-second hype montage from my clips: b-roll hook, then gameplay, then me talking. Music bed under it, a bold title up top to open, a lower-third to close.";

// submit_edit_plan inputSchema = the plan object flat (packages/agent/src/registry.ts).

// Motion-feature plan: punch-in camera move + 1x->8x speed ramp + freeze frame.
// Served when the brief mentions zoom/ramp so each harness run stays deterministic.
const MOTION_PLAN = {
  segments: [
    {
      sourceVideoId: "zoomcheck.webm",
      sourceStartTime: 0,
      sourceEndTime: 5,
      trackIndex: 0,
      targetPosition: 0,
      speed: 1,
      cameraMoves: [{ move: "slow-push", intensity: 1, startTime: 0 }],
      rationale: "Zoom punch on the hook.",
    },
    {
      sourceVideoId: "gameplay-a.webm",
      sourceStartTime: 3,
      sourceEndTime: 9.5,
      trackIndex: 0,
      targetPosition: 5,
      speedRamp: {
        keyframes: [
          { time: 0, speed: 1 },
          { time: 2, speed: 1 },
          { time: 6.5, speed: 8 },
        ],
        freezeFrames: [{ sourceTime: 4, startTime: 5, duration: 1.5 }],
      },
      rationale: "Ramp into the beat, freeze a frame on the game over.",
    },
    {
      sourceVideoId: "broll-c.webm",
      sourceStartTime: 0,
      sourceEndTime: 2.5,
      trackIndex: 0,
      targetPosition: 11.5,
      speed: 1,
      rationale: "Duotone outro — shader probe.",
    },
  ],
  textElements: [],
  effects: [
    {
      targetSegmentIndex: 2,
      type: "duotone",
      intensity: 0.85,
      rationale: "Signature shader probe on the outro.",
    },
  ],
  transitions: [],
  // Deliverable-first motion moment: particle burst riding the FIRST 1.3s of
  // segment B (before the freeze window) — scheduled off the ramp/baseline
  // (5.3-6.7 pb) and freeze (6.5-7.5 pb) verification windows of the harness.
  motionMoments: [
    {
      move: "particle-burst-on-cut",
      segmentIndex: 1,
      duration: 1.3,
      insertIntoEditor: true,
      rationale: "Burst on the B-roll cut.",
    },
  ],
  audioDecisions: [],
  metadata: {
    targetDuration: 12,
    targetPlatform: "social",
    genre: "hype",
    pacing: "fast",
    rationale: "motion feature probe.",
  },
};

const THE_PLAN = {
  segments: [
    {
      sourceVideoId: "broll-c.webm",
      sourceStartTime: 2,
      sourceEndTime: 5,
      trackIndex: 0,
      targetPosition: 0,
      speed: 1,
      rationale: "Colorful b-roll hook to open.",
    },
    {
      sourceVideoId: "gameplay-a.webm",
      sourceStartTime: 3,
      sourceEndTime: 9.5,
      trackIndex: 0,
      targetPosition: 3,
      speed: 1,
      rationale: "Gameplay body — the meat of the montage.",
    },
    {
      sourceVideoId: "talking-b.webm",
      sourceStartTime: 1,
      sourceEndTime: 5.5,
      trackIndex: 0,
      targetPosition: 9,
      speed: 1,
      rationale: "Talking-head close for the personal touch.",
    },
  ],
  textElements: [
    {
      content: "MONET CUTS IT",
      style: "title",
      startTime: 0.3,
      duration: 2.9,
      position: { x: 0.5, y: 0.16 },
      fontFamily: "Inter Black",
      fontSize: 108,
      color: "#00ff9d",
      animation: "pop",
      rationale: "Bold opener, brand-green punch.",
    },
    {
      content: "3 clips - one brief - zero timeline work",
      style: "lower-third",
      startTime: 9.9,
      duration: 4.0,
      position: { x: 0.5, y: 0.85 },
      fontFamily: "Inter",
      fontSize: 44,
      color: "#ffffff",
      animation: "slide-up",
      rationale: "Closing lower-third CTA over the talking head.",
    },
  ],
  effects: [
    {
      targetSegmentIndex: 1,
      type: "hue",
      params: { rotation: 140 },
      rationale: "Director tint: rotate the gameplay hue 140 degrees for a signature look.",
    },
  ],
  transitions: [
    { afterSegmentIndex: 0, type: "crossfade", duration: 0.45, rationale: "Soft blend into gameplay." },
    { afterSegmentIndex: 1, type: "dipToBlack", duration: 0.45, rationale: "Beat-cut into the close." },
  ],
  audioDecisions: [
    {
      type: "music",
      sourceVideoId: "music-bed.wav", // by-name ref — exercises the audio-membership gate
      sourceStartTime: 0,
      sourceEndTime: 14,
      startTime: 0,
      duration: 14,
      volume: 0.32,
      rationale: "Uploaded music bed rides under the whole cut.",
    },
  ],
  metadata: {
    targetDuration: 14,
    targetPlatform: "social",
    genre: "hype",
    pacing: "fast",
    rationale: "14s hype montage per the brief.",
  },
};

function openaiResponse({ text, toolCall, finish }) {
  const message = { role: "assistant", content: text ?? "" };
  if (toolCall) {
    message.content = "";
    message.tool_calls = [
      {
        id: "call_" + Math.random().toString(36).slice(2, 10),
        type: "function",
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
      },
    ];
  }
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-director-1",
    choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : finish ?? "stop" }],
    usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
  };
}

let calls = 0;

// ---- Director-eval corpus mode ------------------------------------------------
// The generative-eval baseline runs plan_edit against .dev-vars Workers AI in
// production; in the sandbox that host is unreachable, so the live rerun uses
// THIS stub. Triggered when the director system prompt names corpus-style
// media ids (video-N / audio-N) and none of the browser-harness' own media —
// we then emit a minimal VALID plan computed from the very system text the
// model received: real media ids, no hallucinated audio (music decision only
// when an audio id actually exists), no targetDuration (exercises the
// prompt-duration derivation the live run measures).
function buildEvalPlan(sysText) {
  const seenVideo = [];
  for (const m of sysText.matchAll(/\bvideo-\d+\b/g)) {
    if (!seenVideo.includes(m[0])) seenVideo.push(m[0]);
  }
  const seenAudio = [];
  for (const m of sysText.matchAll(/\baudio-\d+\b/g)) {
    if (!seenAudio.includes(m[0])) seenAudio.push(m[0]);
  }
  const primary = seenVideo[0];
  const secondary = seenVideo[1] ?? seenVideo[0];
  if (!primary) return null;
  const segments = [
    {
      sourceVideoId: primary,
      sourceStartTime: 0,
      sourceEndTime: 3.5,
      trackIndex: 0,
      targetPosition: 0,
      speed: 1,
      rationale: "Hook.",
    },
    {
      sourceVideoId: secondary,
      sourceStartTime: secondary === primary ? 3.5 : 0,
      sourceEndTime: secondary === primary ? 7 : 3.5,
      trackIndex: 0,
      targetPosition: 3.5,
      speed: 1,
      rationale: "Body.",
    },
  ];
  const plan = {
    segments,
    textElements: [
      {
        content: "EVAL MARKER",
        style: "title",
        startTime: 0.2,
        duration: 2.5,
        position: { x: 0.5, y: 0.12 },
        fontFamily: "Arial",
        fontSize: 96,
        color: "#ffffff",
        animation: "none",
        rationale: "Overlay gate marker.",
      },
    ],
    effects: [],
    transitions: [
      { afterSegmentIndex: 0, type: "crossfade", duration: 0.3, rationale: "soft join" },
    ],
    layout: [],
    audioDecisions: seenAudio.length
      ? [
          {
            type: "music",
            sourceVideoId: seenAudio[0],
            sourceStartTime: 0,
            sourceEndTime: 7,
            startTime: 0,
            duration: 7,
            volume: 0.35,
            rationale: "bed under the whole edit",
          },
        ]
      : [],
    metadata: {
      targetPlatform: "social",
      genre: "eval",
      pacing: "fast",
      rationale: "Sandbox-eval generic valid plan.",
    },
  };
  return plan;
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      body = {};
    }
    calls += 1;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sys = messages.find((m) => m.role === "system");
    const sysText = typeof sys?.content === "string" ? sys.content : "";
    const isDirector = sysText.includes("Canonical sourceVideoId") || sysText.includes("## Available audio");

    const assistantToolCallNames = new Set(
      messages
        .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
        .flatMap((m) => m.tool_calls.map((tc) => tc?.function?.name ?? tc?.name)),
    );
    const toolResultNames = new Set(
      messages.filter((m) => m.role === "tool").map((m) => m.name).filter(Boolean),
    );

    let out;
    let tag;
    if (isDirector) {
      const planSubmitted =
        assistantToolCallNames.has("submit_edit_plan") || toolResultNames.has("submit_edit_plan");
      // Corpus-eval branch: corpus prompts are served with canonical video-N
      // media ids; the browser harness never has ids in that shape, so key on
      // it alone (corpus media FILE NAMES collide with harness names, e.g.
      // gameplay-a.mp4 — do not test for those).
      const evalPlan = /\bvideo-\d+\b/.test(sysText) ? buildEvalPlan(sysText) : null;
      if (!planSubmitted && evalPlan) {
        out = openaiResponse({ toolCall: { name: "submit_edit_plan", args: evalPlan } });
        tag = "DIRECTOR/eval-plan";
        console.log(`[stub] #${calls} ${tag} (ys=${sysText.length}ch)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      if (evalPlan && planSubmitted) {
        out = openaiResponse({ text: "Plan stands — no revision needed.", finish: "stop" });
        tag = "DIRECTOR/eval-keep";
        console.log(`[stub] #${calls} ${tag}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      if (!planSubmitted) {
        const sysOfCall = typeof sys?.content === "string" ? sys.content : "";
        const userText = [...messages.filter((m) => m.role === "system"), ...messages.filter((m) => m.role === "user"), { content: sysOfCall }].map((m) => typeof m.content === "string" ? m.content : "").join("\n---\n");
        const wantsMotion = /zoom punch|speed ramp|freeze a frame|zoom|ramp|freeze frame/i.test(userText);
        console.log(`[stub] motion-detect: ${wantsMotion} (scanned ${userText.length}ch incl. system)`);
        out = openaiResponse({ toolCall: { name: "submit_edit_plan", args: wantsMotion ? MOTION_PLAN : THE_PLAN } });
        tag = wantsMotion ? "DIRECTOR/motion-plan" : "DIRECTOR/plan";
      } else {
        out = openaiResponse({ text: "Plan stands — no revision needed.", finish: "stop" });
        tag = "DIRECTOR/keep";
      }
    } else if (!(assistantToolCallNames.has("plan_edit") || toolResultNames.has("plan_edit"))) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userBrief = typeof lastUser?.content === "string" && lastUser.content.length > 10 ? lastUser.content : BRIEF;
      out = openaiResponse({ toolCall: { name: "plan_edit", args: { prompt: userBrief } } });
      tag = "AGENT/plan_edit";
    } else {
      out = openaiResponse({
        text: "Done — I cut your 14-second montage: b-roll hook, gameplay body, your talking close, stamped title, closing lower-third, and the uploaded music bed riding under everything.",
        finish: "stop",
      });
      tag = "AGENT/final";
    }
    console.log(`[stub] #${calls} ${tag} (sys=${sysText.length}ch, msgs=${messages.length})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[stub] mock director listening on http://127.0.0.1:${PORT}/v1/chat/completions`);
});
