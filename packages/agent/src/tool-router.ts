import { listTools } from "./registry";
import type { RegisteredTool } from "./registry";

/** Leave headroom below provider limits for future built-in/meta tools. */
export const DEFAULT_AGENT_TOOL_LIMIT = 120;

const ALWAYS_AVAILABLE = new Set([
  "get_editor_state",
  "list_media",
  "list_tracks",
  "list_clips",
  "get_clip",
  "get_capabilities",
  "create_project",
  "list_projects",
  "open_project",
  "save_project",
  "execute_action",
  "batch_actions",
  // safety net: must be reachable on every turn
  "create_checkpoint",
  "list_checkpoints",
  "restore_checkpoint",
  "undo",
  "redo",
]);

/**
 * Motion tools used to sit in ALWAYS_AVAILABLE, where a flat 10,000 score
 * outbid every editing tool (they score at most 10,000 + 200). On a capped
 * budget that meant motion took 10 of 25 slots for every prompt, leaving
 * effect/transition/text/clip tools to fight over the last 2. They are still
 * unconditional when the prompt is motion-shaped, and always available again
 * once the conversation has actually used one (prior).
 */
const MOTION_ALWAYS_AVAILABLE = new Set([
  "list_motion_compositions",
  "get_motion_composition",
  "create_motion_composition",
  "add_motion_layer",
  "add_motion_layers",
  "set_motion_layer_transform",
  "animate_layer",
  "remove_motion_layer",
  "render_motion_frame",
  "insert_motion_into_editor",
]);

const MOTION_TERMS = /\b(motion|composition|layer|keyframe|animate|animation|after effects|lower third|title card|kinetic|lottie|svg|figma|particle|shader|mask|matte|precomp|camera|render frame)\b/i;
const CREATION_TERMS = /\b(3d|three[- ]?d|product|character|scene|model|gltf|glb|rig|mesh|material|texture|bevel|displacement|x[- ]?ray|cloth|camera module|exploded|cinematic|decal|cutaway)\b/i;
const DIRECTOR_TERMS = /\b(direct|edit|cut|trim|highlight|reel|montage|compilation|remix|create|make|kreate|analyze|footage|segment|plan|sequence|chop|splice|join|video|film|clip|footage|b-roll|podcast|vlog|social|tiktok|youtube|instagram|reel|short)\b/i;

/**
 * Domains that the director (Monet) needs access to when authoring edits.
 * This ensures effect, transition, text, audio, clip, and track tools are
 * always available when the user asks for an edit — not just AI tools.
 */
const DIRECTOR_DOMAINS = new Set([
  "ai",           // plan_edit, expand_prompt, extract_segments
  "effect",       // add_video_effect, remove_video_effect
  "transition",   // add_transition, remove_transition
  "text",         // create_text_clip, update_text_clip
  "audio",        // audio tools
  "clip",         // split_clip, move_clip, duplicate_clip
  "track",        // add_track, remove_track
  "transform",    // transform/update
  "speed",        // speed changes
  "color",        // color grading
  "subtitle",     // subtitle tools
  "marker",       // markers
  "export",       // export tools
]);

const words = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3);

const isAlwaysAvailable = (toolName: string, wantsMotion: boolean): boolean =>
  ALWAYS_AVAILABLE.has(toolName) || (wantsMotion && MOTION_ALWAYS_AVAILABLE.has(toolName));

function relevance(
  tool: RegisteredTool,
  promptWords: Set<string>,
  wantsMotion: boolean,
): number {
  if (isAlwaysAvailable(tool.name, wantsMotion)) return 10_000;
  const name = new Set(words(tool.name));
  const title = new Set(words(tool.title));
  const description = new Set(words(tool.description));
  let score = tool.readOnly ? 12 : 0;
  for (const word of promptWords) {
    if (name.has(word)) score += 18;
    if (title.has(word)) score += 10;
    if (description.has(word)) score += 2;
  }
  return score;
}

function isCreationTool(tool: RegisteredTool): boolean {
  const haystack = `${tool.name} ${tool.title} ${tool.description}`;
  return /creation|3d|scene3d|gltf|glb|rigging|humanoid|product cinematic/i.test(haystack);
}

/**
 * Route a user request to a provider-safe subset of the full editor registry.
 * The registry remains authoritative and executable; routing only limits the
 * function schemas sent on this turn so large registries stay within provider
 * limits and do not waste the user's context window.
 */
export function selectToolsForPrompt(
  prompt: string,
  options: { readonly maxTools?: number; readonly priorToolNames?: readonly string[] } = {},
): string[] {
  const maxTools = Math.max(1, options.maxTools ?? DEFAULT_AGENT_TOOL_LIMIT);
  const wantsMotion = MOTION_TERMS.test(prompt);
  const wantsCreation = CREATION_TERMS.test(prompt);
  const wantsDirector = DIRECTOR_TERMS.test(prompt);
  const prior = new Set(options.priorToolNames ?? []);
  const promptWords = new Set(words(prompt));

  const candidates = listTools().filter((tool) => {
    if (isAlwaysAvailable(tool.name, wantsMotion) || prior.has(tool.name)) return true;

    // Director mode: include all editing-relevant domains so the AI can
    // author a complete edit with effects, transitions, text, audio, etc.
    if (wantsDirector && DIRECTOR_DOMAINS.has(tool.domain)) return true;

    // Motion-only: include motion domain tools (but not creation)
    if (!wantsMotion && !wantsCreation) return tool.domain !== "motion";
    if (wantsCreation && isCreationTool(tool)) return true;
    if (wantsMotion && tool.domain === "motion" && !isCreationTool(tool)) return true;

    // Default: include read, project, media, export, raw domains
    return tool.domain === "read" || ["project", "media", "export", "raw"].includes(tool.domain);
  });

  return candidates
    .map((tool, index) => ({
      tool,
      index,
      score:
        relevance(tool, promptWords, wantsMotion) +
        (prior.has(tool.name) ? 5_000 : 0) +
        (wantsCreation && isCreationTool(tool) ? 100 : 0) +
        (wantsMotion && tool.domain === "motion" ? 50 : 0) +
        (wantsDirector && DIRECTOR_DOMAINS.has(tool.domain) ? 200 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxTools)
    .sort((a, b) => a.index - b.index)
    .map(({ tool }) => tool.name);
}
