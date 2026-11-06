import { listTools } from "./registry";
import type { RegisteredTool } from "./registry";
import { mentionsReferenceWorkflow } from "./mirror-intent";

/** Leave headroom below provider limits for future built-in/meta tools. */
export const DEFAULT_AGENT_TOOL_LIMIT = 120;

export const ALWAYS_AVAILABLE = new Set([
  "get_editor_state",
  "list_media",
  "list_tracks",
  "list_clips",
  "get_clip",
  "get_capabilities",
  "execute_action",
  "batch_actions",
  // discovery: any registered tool must stay reachable even when its own schema
  // is not in this turn's routed subset, and any action type must be listable.
  "search_tools",
  "run_tool",
  "list_action_types",
  // The director's required entry point: `runTurn` rejects an edit turn whose
  // timeline is still empty, so this schema must survive any provider cap.
  "plan_edit",
  // safety net: must be reachable on every turn
  "create_checkpoint",
  "list_checkpoints",
  "restore_checkpoint",
  "undo",
  "redo",
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

const DOMAIN_ENTRYPOINTS: Record<string, readonly string[]> = {
  subtitle: ["add_subtitle", "auto_caption"],
  text: ["create_text_clip"],
  effect: ["add_video_effect"],
  transition: ["add_transition"],
  audio: ["add_audio_clip"],
  clip: ["trim_clip", "split_clip"],
  motion: ["create_motion_composition", "add_motion_layer", "add_motion_layers"],
};

const words = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .map((word) => {
      if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
      if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) {
        return word.slice(0, -1);
      }
      return word;
    });

function promptWords(value: string): Set<string> {
  const result = new Set(words(value));
  if (result.has("caption")) result.add("subtitle");
  if (result.has("subtitle")) result.add("caption");
  return result;
}

function requestedDomains(tokens: Set<string>): Set<string> {
  const domains = new Set<string>();
  const domainHints: Record<string, readonly string[]> = {
    caption: ["subtitle", "text"],
    subtitle: ["subtitle", "text"],
    text: ["text"],
    title: ["text"],
    transition: ["transition"],
    effect: ["effect"],
    filter: ["effect"],
    audio: ["audio"],
    music: ["audio"],
    sound: ["audio"],
    speed: ["speed"],
    ramp: ["speed"],
    color: ["color"],
    grade: ["color"],
    trim: ["clip"],
    cut: ["clip"],
    split: ["clip"],
    clip: ["clip"],
    crop: ["transform"],
    rotate: ["transform"],
    zoom: ["transform"],
    reframe: ["transform"],
    marker: ["marker"],
    export: ["export"],
    motion: ["motion"],
    composition: ["motion"],
    layer: ["motion"],
    keyframe: ["motion"],
    animate: ["motion"],
  };
  for (const token of tokens) {
    for (const domain of domainHints[token] ?? []) domains.add(domain);
  }
  return domains;
}

function relevance(tool: RegisteredTool, promptWords: Set<string>): number {
  if (ALWAYS_AVAILABLE.has(tool.name)) return 10_000;
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
 *
 * Two guarantees the model depends on:
 *   - every ALWAYS_AVAILABLE tool is included, even when `maxTools` is smaller
 *     than that set (the result may exceed `maxTools` by that much);
 *   - a tool that is not selected here is still reachable, because
 *     `search_tools` + `run_tool` are always available.
 */
export function selectToolsForPrompt(
  prompt: string,
  options: { readonly maxTools?: number; readonly priorToolNames?: readonly string[] } = {},
): string[] {
  const maxTools = Math.max(1, options.maxTools ?? DEFAULT_AGENT_TOOL_LIMIT);
  const wantsMotion = MOTION_TERMS.test(prompt);
  const wantsCreation = CREATION_TERMS.test(prompt);
  // A reference request is a director request: "/mirror" carries no editing
  // vocabulary at all, so without this the mirror and planning tools would
  // never reach the model.
  const wantsReference = mentionsReferenceWorkflow(prompt);
  const wantsDirector = DIRECTOR_TERMS.test(prompt) || wantsReference;
  const prior = new Set(options.priorToolNames ?? []);
  const promptTokens = promptWords(prompt);
  const promptDomains = requestedDomains(promptTokens);
  if (wantsMotion) promptDomains.add("motion");
  if (wantsCreation) promptDomains.add("creation");

  const candidates = listTools().filter((tool) => {
    // Structured-output tools such as submit_edit_plan are only for nested
    // provider calls made by plan_edit. Never expose them on the outer chat
    // turn: the generic executor correctly refuses to run them directly.
    if (tool.internal) return false;
    if (ALWAYS_AVAILABLE.has(tool.name) || prior.has(tool.name)) return true;

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

  const scored = candidates.map((tool, index) => ({
    tool,
    index,
    score:
      relevance(tool, promptTokens) +
      (prior.has(tool.name) ? 5_000 : 0) +
      (wantsCreation && isCreationTool(tool) ? 100 : 0) +
      (wantsMotion && tool.domain === "motion" ? 50 : 0) +
      (promptDomains.has(tool.domain) ? 500 : 0) +
      (DOMAIN_ENTRYPOINTS[tool.domain]?.includes(tool.name) && promptDomains.has(tool.domain) ? 800 : 0) +
      (wantsDirector && DIRECTOR_DOMAINS.has(tool.domain) ? 200 : 0),
  }));

  // "Always available" has to mean always: safety-net and discovery tools are
  // not optional, so they are admitted first and the cap only governs the
  // optional remainder. A tight cap (a small provider limit) must not be able
  // to strand undo, checkpoints, execute_action, search_tools or run_tool —
  // which is exactly what used to happen once the always-available set grew
  // past the cap, because ties broke on registry order.
  const mandatory = scored.filter((entry) => ALWAYS_AVAILABLE.has(entry.tool.name));
  const optional = scored
    .filter((entry) => !ALWAYS_AVAILABLE.has(entry.tool.name))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const remaining = Math.max(0, maxTools - mandatory.length);

  return [...mandatory, ...optional.slice(0, remaining)]
    .sort((a, b) => a.index - b.index)
    .map(({ tool }) => tool.name);
}
