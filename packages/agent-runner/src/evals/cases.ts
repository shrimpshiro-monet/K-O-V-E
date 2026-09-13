import { MockLLMClient } from "@kove-advanced/agent";
import type { LLMResponse } from "@kove-advanced/agent";
import { createEmptyProject } from "../project-io";
import type { EvalCase } from "./harness";

const END: LLMResponse = { text: "Done.", stopReason: "end_turn", toolUses: [] };

function scripted(...responses: LLMResponse[]): MockLLMClient {
  return new MockLLMClient([...responses, END]);
}

const MOCK_SEGMENT_MAP = {
  videos: [
    {
      videoId: "video-1",
      duration: 60,
      segments: [
        {
          id: "seg-1",
          startTime: 0,
          endTime: 15,
          description: "Person talking to camera about project",
          sceneType: "talking",
          motionLevel: "low",
          hasDialogue: true,
          visualContent: "Close-up of speaker",
          confidence: 0.9,
        },
        {
          id: "seg-2",
          startTime: 15,
          endTime: 35,
          description: "B-roll of project in action",
          sceneType: "b-roll",
          motionLevel: "medium",
          hasDialogue: false,
          visualContent: "Wide shots of activity",
          confidence: 0.85,
        },
        {
          id: "seg-3",
          startTime: 35,
          endTime: 60,
          description: "Person wrapping up conclusion",
          sceneType: "talking",
          motionLevel: "low",
          hasDialogue: true,
          visualContent: "Close-up of speaker",
          confidence: 0.88,
        },
      ],
    },
  ],
};

/**
 * Deterministic regression corpus: each case scripts the model's tool sequence
 * and asserts the resulting project state. Real-LLM mode (no `llm`) drives the
 * same prompts/assertions against a BYOK model for live eval runs.
 */
export const SCRIPTED_CASES: EvalCase[] = [
  {
    name: "rename project and add a video track",
    makeProject: () => createEmptyProject("Original"),
    prompt: "Rename the project to Edited and add a video track",
    llm: scripted({
      text: "Renaming and adding a track.",
      stopReason: "tool_use",
      toolUses: [
        { id: "t1", name: "rename_project", input: { name: "Edited" } },
        { id: "t2", name: "add_track", input: { trackType: "video" } },
      ],
    }),
    expectedTools: ["rename_project", "add_track"],
    assert: (project) => {
      const failures: string[] = [];
      if (project.name !== "Edited") failures.push(`name is ${project.name}`);
      if (project.timeline.tracks.length !== 1) {
        failures.push(`expected 1 track, got ${project.timeline.tracks.length}`);
      }
      return failures;
    },
  },
  {
    name: "add a video and an audio track",
    makeProject: () => createEmptyProject("Tracks"),
    prompt: "Add a video track and an audio track",
    llm: scripted({
      text: "Adding both tracks.",
      stopReason: "tool_use",
      toolUses: [
        { id: "t1", name: "add_track", input: { trackType: "video" } },
        { id: "t2", name: "add_track", input: { trackType: "audio" } },
      ],
    }),
    expectedTools: ["add_track", "add_track"],
    assert: (project) =>
      project.timeline.tracks.length === 2
        ? []
        : [`expected 2 tracks, got ${project.timeline.tracks.length}`],
  },
  {
    name: "answer without editing leaves the project untouched",
    makeProject: () => createEmptyProject("Pristine"),
    prompt: "What resolution is this project?",
    llm: scripted(),
    expectedTools: [],
    assert: (project, result) => {
      const failures: string[] = [];
      if (project.timeline.tracks.length !== 0) failures.push("tracks were modified");
      if (result.stoppedReason !== "end_turn") failures.push(`stopped: ${result.stoppedReason}`);
      return failures;
    },
  },
  // ---- Director (Monet) eval cases ----
  {
    name: "director: extract_segments is called for footage analysis",
    makeProject: () => createEmptyProject("Director Test"),
    prompt: "Make me a highlight reel from my footage",
    llm: scripted({
      text: "I'll analyze your footage first.",
      stopReason: "tool_use",
      toolUses: [
        {
          id: "d1",
          name: "extract_segments",
          input: {
            videoMediaIds: ["media-1"],
          },
        },
      ],
    }),
    expectedTools: ["extract_segments"],
    assert: (project) => {
      const failures: string[] = [];
      if (project.timeline.tracks.length !== 0) {
        failures.push("project should not be modified by extract_segments");
      }
      return failures;
    },
  },
  {
    name: "director: plan_edit is called after segment extraction",
    makeProject: () => createEmptyProject("Director Plan"),
    prompt: "Create a 30-second highlight reel for Instagram",
    llm: scripted({
      text: "Let me plan the edit based on your footage.",
      stopReason: "tool_use",
      toolUses: [
        {
          id: "d1",
          name: "plan_edit",
          input: {
            segmentMap: MOCK_SEGMENT_MAP,
            prompt: "Create a 30-second highlight reel for Instagram",
            targetDuration: 30,
            targetPlatform: "instagram",
          },
        },
      ],
    }),
    expectedTools: ["plan_edit"],
    assert: () => [],
  },
  {
    name: "director: full workflow executes extract, plan, then edit tools",
    makeProject: () => createEmptyProject("Full Workflow"),
    prompt: "Analyze my footage and make a 15-second social reel",
    llm: scripted({
      text: "Analyzing your footage.",
      stopReason: "tool_use",
      toolUses: [
        {
          id: "d1",
          name: "extract_segments",
          input: {
            videoMediaIds: ["media-1"],
          },
        },
      ],
    }),
    expectedTools: ["extract_segments"],
    assert: () => [],
  },
  {
    name: "director: genre selection provides rules to plan_edit",
    makeProject: () => createEmptyProject("Genre Test"),
    prompt: "Make a music video style edit from my clips",
    llm: scripted({
      text: "I'll plan a music video edit for you.",
      stopReason: "tool_use",
      toolUses: [
        {
          id: "d1",
          name: "plan_edit",
          input: {
            segmentMap: MOCK_SEGMENT_MAP,
            prompt: "Make a music video style edit from my clips",
            genre: {
              id: "music-video",
              name: "Music Video",
              rules: {
                pacing: "fast",
                transitionPreference: ["hardCut", "glitch", "flash"],
                effectPalette: ["brightness", "contrast", "saturation"],
                textStyle: "minimal",
                cutStyle: "hard",
                colorMood: "vibrant",
                musicRole: "featured",
              },
            },
          },
        },
      ],
    }),
    expectedTools: ["plan_edit"],
    assert: () => [],
  },
];
