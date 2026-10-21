// Real-corpus reference-intent run: drives the headless /mirror, /recreate and
// /reference flow against the REAL game-01 corpus project with a REAL measured
// reference profile (browser-measured SPIDERMAN clip), instead of a synthetic
// fixture. Skips when the local evaluation corpus or profile is absent — both
// live under evaluation-files/ and are never committed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FnLLMClient } from "@kove-advanced/agent";
import { buildBaselineProject } from "@kove-advanced/agent/eval/baseline";
import { loadCorpus } from "@kove-advanced/agent/eval/corpus";
import { parseReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { Project } from "@kove-advanced/core/types/project";
import { runHeadlessEdit } from "./run";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CORPUS_DIR = join(REPO_ROOT, "evaluation-files");
const CORPUS_PATH = join(CORPUS_DIR, "projects.json");
const PROFILE_PATH = join(CORPUS_DIR, "reference", "real-spiderman-profile.json");

interface CorpusEntry {
  readonly id: string;
  readonly media: readonly string[];
  readonly reference: string | null;
}

function realAssetsPresent(): boolean {
  if (!existsSync(CORPUS_PATH) || !existsSync(PROFILE_PATH)) return false;
  const ffprobe = spawnSync("ffprobe", ["-version"], { encoding: "utf8" });
  if (ffprobe.error) return false;
  try {
    const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as CorpusEntry[];
    const entry = corpus.find((candidate) => candidate.id === "game-01");
    if (!entry) return false;
    return [...entry.media, ...(entry.reference ? [entry.reference] : [])].every((relative) =>
      existsSync(join(CORPUS_DIR, relative)),
    );
  } catch {
    return false;
  }
}

const available = realAssetsPresent();
const realTest = available ? it : it.skip;
const realTitle = (title: string): string =>
  available ? title : `${title} (skipped: real corpus/reference profile not present; see docs/AGENT-EVAL-CORPUS.md)`;

interface MeasuredBundle {
  readonly profile: unknown;
}

function realGameProject(): Project {
  const corpus = loadCorpus(CORPUS_PATH);
  const entry = corpus.find((candidate) => candidate.id === "game-01");
  if (!entry) throw new Error("game-01 missing from corpus");
  const { project } = buildBaselineProject(entry);
  const bundle = JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as MeasuredBundle;
  const profile = parseReferenceProfile(bundle.profile);
  return { ...project, mirrorProfile: profile };
}

function referenceDirective(userContent: string): string {
  const start = userContent.indexOf("[REFERENCE]");
  const end = userContent.indexOf("[/REFERENCE]");
  if (start < 0 || end < 0) throw new Error(`no [REFERENCE] block in:\n${userContent.slice(0, 400)}`);
  return userContent.slice(start, end);
}

describe("real-profile headless reference intent (game-01 + measured reference)", () => {
  realTest(
    realTitle("replicate: applies the measured structure before the model and forbids plan_edit"),
    async () => {
      const project = realGameProject();
      const shotCount = project.mirrorProfile?.shots.length ?? 0;
      expect(shotCount).toBeGreaterThan(1);

      const responses = [
        {
          text: "Added the title.",
          stopReason: "tool_use" as const,
          toolUses: [
            { id: "c1", name: "create_text_clip", input: { clip: { text: "KOVE", startTime: 1, duration: 2 } } },
          ],
        },
        { text: "Done.", stopReason: "end_turn" as const, toolUses: [] },
      ];
      let index = 0;
      const scripted = new FnLLMClient(async () => responses[Math.min(index++, responses.length - 1)]!);

      const { project: after, result } = await runHeadlessEdit({
        project,
        prompt: "/mirror make the title cards punchy",
        provider: "anthropic",
        model: "mock",
        apiKey: "unused",
        llm: scripted,
      });

      expect(result.stoppedReason).toBe("end_turn");
      expect(result.committed).toBe(true);

      // Structure was applied before the model ran: one clip per measured shot.
      const videoClips = after.timeline.tracks
        .flatMap((track) => track.clips)
        .filter((clip) => after.mediaLibrary.items.find((item) => item.id === clip.mediaId)?.type === "video");
      expect(videoClips).toHaveLength(shotCount);
      const referenceId = after.mediaLibrary.items.find((item) => item.analysisRole === "reference")!.id;
      expect(videoClips.some((clip) => clip.mediaId === referenceId)).toBe(false);

      // The directive carries the real measured facts, including the profile
      // warnings and duration the web app also forwards.
      const firstUser = result.messages.find((message) => message.role === "user")!;
      const directive = referenceDirective(firstUser.content);
      const fps = project.mirrorProfile!.fps;
      const durationSeconds = (project.mirrorProfile!.durationFrames * fps.den) / fps.num;
      expect(directive).toContain(`Measured: ${shotCount} shots, ${durationSeconds.toFixed(2)}s`);
      expect(directive).toContain("REPLICATE (1:1 mirror)");
      expect(directive).toContain("Do NOT call plan_edit");
      expect(directive).toContain("analysisRole=reference");
      if (project.mirrorProfile?.warnings?.length) {
        expect(directive).toContain(project.mirrorProfile.warnings[0]!);
      }

      // plan_edit never ran; the craft call landed on top of the structure.
      const toolNames = result.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.toolUses.map((use) => use.name));
      expect(toolNames).not.toContain("plan_edit");
      expect(toolNames).toContain("create_text_clip");
      expect((after.textClips ?? []).length).toBeGreaterThan(0);
    },
    60_000,
  );

  realTest(
    realTitle("reference: leaves the timeline empty and instructs plan_edit"),
    async () => {
      const project = realGameProject();
      const scripted = new FnLLMClient(async () => ({
        text: "Planned.",
        stopReason: "end_turn" as const,
        toolUses: [],
      }));

      const { project: after, result } = await runHeadlessEdit({
        project,
        prompt: "/reference cut something punchy",
        provider: "anthropic",
        model: "mock",
        apiKey: "unused",
        llm: scripted,
      });

      expect(result.stoppedReason).toBe("end_turn");
      expect(after.timeline.tracks.flatMap((track) => track.clips)).toHaveLength(0);

      const firstUser = result.messages.find((message) => message.role === "user")!;
      const directive = referenceDirective(firstUser.content);
      expect(directive).toContain("REFERENCE (style guidance only)");
      expect(directive).toContain("NOT applied to the timeline");
      expect(directive).toContain("plan_edit");
      expect(directive).toContain("never footage to cut");
    },
    60_000,
  );

  realTest(
    realTitle("recreate: rebuilds the structure and claims the creative layer"),
    async () => {
      const project = realGameProject();
      const shotCount = project.mirrorProfile?.shots.length ?? 0;
      const scripted = new FnLLMClient(async () => ({
        text: "Done.",
        stopReason: "end_turn" as const,
        toolUses: [],
      }));

      const { project: after, result } = await runHeadlessEdit({
        project,
        prompt: "/recreate do it in my style",
        provider: "anthropic",
        model: "mock",
        apiKey: "unused",
        llm: scripted,
      });

      expect(result.stoppedReason).toBe("end_turn");
      expect(after.timeline.tracks.flatMap((track) => track.clips)).toHaveLength(shotCount);

      const firstUser = result.messages.find((message) => message.role === "user")!;
      const directive = referenceDirective(firstUser.content);
      expect(directive).toContain("RECREATE (similar edit, own creative layer)");
      expect(directive).toContain("re-author the creative layer yourself");
      expect(directive).toContain("Do NOT call plan_edit");
    },
    60_000,
  );
});
