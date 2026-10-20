/**
 * What the director should do with a reference video the user attached.
 *
 * - `replicate` — rebuild the user's footage to the reference's structure, 1:1.
 * - `recreate`  — same structure, but the creative layer is the model's own.
 * - `reference` — style guidance only; nothing is rebuilt from it.
 *
 * The intent travels with the message: an explicit `/mirror`, `/recreate` or
 * `/reference` command wins, then keyword phrasing, then whatever the user
 * picked in the composer. The model never has to guess which one was meant.
 */
export type ReferenceIntent = "replicate" | "recreate" | "reference";

export const REFERENCE_INTENTS: readonly ReferenceIntent[] = ["replicate", "recreate", "reference"];

/** Slash commands the director understands, mapped onto the intent they mean. */
export const REFERENCE_INTENT_COMMANDS = {
  mirror: "replicate",
  recreate: "recreate",
  reference: "reference",
} as const satisfies Record<string, ReferenceIntent>;

export type ReferenceIntentSource = "command" | "keyword" | "picker" | "none";

export interface ParsedReferenceIntent {
  /** The intent the message asks for, or null when it says nothing about one. */
  readonly intent: ReferenceIntent | null;
  /** Where the intent came from, so the UI can explain what it is about to do. */
  readonly source: ReferenceIntentSource;
  /** The slash command that was used, when one was. */
  readonly command: string | null;
  /** The message with the slash command removed, ready to send to the model. */
  readonly prompt: string;
}

const COMMAND_PATTERN = /(^|\s)\/(mirror|recreate|reference)\b/i;

/**
 * Keyword phrasing, most specific first. These are deliberately narrow: a
 * loose match would silently turn an ordinary "reference the previous plan"
 * into a mirror request.
 */
const KEYWORD_PATTERNS: ReadonlyArray<readonly [ReferenceIntent, RegExp]> = [
  ["replicate", /\breplicate\b|\breproduction of\b|\bexactly like\b|\bsame cuts?\b|\b1\s*:\s*1\b|\bmirror (?:this|my|the|that)\b/i],
  ["recreate", /\brecreate\b|\bsimilar\b|\bin the style of\b|\bsame (?:style|vibe|energy|pacing|tone|rhythm)\b|\blike this but\b|\bmatch the (?:style|pacing|energy|vibe)\b/i],
  ["reference", /\bas (?:a )?reference\b|\breference only\b|\bjust (?:as )?(?:a )?reference\b|\bfor reference\b|\btreat (?:it|this) as (?:a )?reference\b/i],
];

/** Reads the intent out of a message: explicit command first, then keywords. */
export function parseReferenceIntent(text: string): ParsedReferenceIntent {
  const command = COMMAND_PATTERN.exec(text);
  if (command) {
    const name = command[2]!.toLowerCase() as keyof typeof REFERENCE_INTENT_COMMANDS;
    const intent = REFERENCE_INTENT_COMMANDS[name];
    const prompt = `${text.slice(0, command.index)}${text.slice(command.index + command[0].length)}`.replace(/\s+/g, " ").trim();
    return { intent, source: "command", command: `/${name}`, prompt };
  }
  for (const [intent, pattern] of KEYWORD_PATTERNS) {
    if (pattern.test(text)) return { intent, source: "keyword", command: null, prompt: text.trim() };
  }
  return { intent: null, source: "none", command: null, prompt: text.trim() };
}

/**
 * True when a message is about the reference workflow at all. Used by the tool
 * router so a bare "/mirror" still reaches the mirror and planning tools.
 */
export function mentionsReferenceWorkflow(text: string): boolean {
  if (parseReferenceIntent(text).intent !== null) return true;
  return /\breference\b/i.test(text) && /\b(mirror|replicate|recreate|match|like|same)\b/i.test(text);
}

/** What the app already did to the timeline before the model's turn starts. */
export type ReferenceApplication = "none" | "structure";

/** The measured facts about the reference that the model is allowed to see. */
export interface ReferenceIntentFacts {
  readonly intent: ReferenceIntent;
  readonly referenceName: string;
  readonly referenceMediaId?: string;
  /** False when the user asked for a reference workflow without attaching one. */
  readonly attached?: boolean;
  readonly fps?: string;
  readonly durationSeconds?: number;
  readonly shotCount?: number;
  readonly aspectRatio?: string;
  readonly dominantMoves?: readonly string[];
  readonly captionWindowCount?: number;
  readonly beatCount?: number;
  readonly warnings?: readonly string[];
  /** "structure" when the reference's shot structure is already on the timeline. */
  readonly applied: ReferenceApplication;
}

const INTENT_LABEL: Record<ReferenceIntent, string> = {
  replicate: "REPLICATE (1:1 mirror)",
  recreate: "RECREATE (similar edit, own creative layer)",
  reference: "REFERENCE (style guidance only)",
};

/**
 * The block the model receives with the user's message. It states what the
 * reference is, what the app already applied, and exactly which tools the
 * model may use — the model must not re-plan a timeline the app just built.
 */
export function referenceIntentDirective(facts: ReferenceIntentFacts): string {
  const lines: string[] = ["[REFERENCE]"];

  if (facts.attached === false) {
    lines.push(`No reference video is attached. Intent requested: ${INTENT_LABEL[facts.intent]}.`);
    lines.push("Your job this turn: tell the user that no reference is attached and ask them to attach one (drag a video into the chat, or mark an existing video as a reference in the Assets panel). Do not edit the timeline yet.");
    lines.push("[/REFERENCE]");
    return lines.join("\n");
  }

  lines.push(`Reference video: "${facts.referenceName}"${facts.referenceMediaId ? ` (media id ${facts.referenceMediaId})` : ""}, tagged analysisRole=reference.`);
  const measured: string[] = [];
  if (facts.shotCount !== undefined) measured.push(`${facts.shotCount} shots`);
  if (facts.durationSeconds !== undefined) measured.push(`${facts.durationSeconds.toFixed(2)}s`);
  if (facts.fps) measured.push(`${facts.fps} fps`);
  if (facts.aspectRatio) measured.push(facts.aspectRatio);
  if (facts.dominantMoves?.length) measured.push(`camera moves: ${facts.dominantMoves.join(", ")}`);
  if (facts.beatCount !== undefined) measured.push(`${facts.beatCount} beats`);
  if (facts.captionWindowCount !== undefined) measured.push(`${facts.captionWindowCount} caption windows`);
  if (measured.length) lines.push(`Measured: ${measured.join(", ")}.`);
  if (facts.warnings?.length) lines.push(`Reference warnings: ${facts.warnings.join(" ")}`);
  lines.push(`Frame clock: measured from the file, not assumed.`);
  lines.push(`Intent: ${INTENT_LABEL[facts.intent]}.`);

  if (facts.applied === "structure") {
    lines.push("Already done for you: the reference's shot structure, pacing and measured grade are on the timeline as editable clips, and the EditDNA profile is attached to the project.");
    if (facts.intent === "replicate") {
      lines.push("Your job this turn: add the finishing craft to the applied structure — captions and title cards, transitions, audio and color that match the reference. Use targeted tools (create_text_clip, add_video_effect, add_transition, audio and color tools).");
      lines.push("Do NOT call plan_edit: it replaces the timeline and would throw away the applied structure. Do not re-cut the source clips.");
    } else {
      lines.push("Your job this turn: re-author the creative layer yourself — your own titles, captions, effects, transitions and grade in the reference's style. Do not copy the reference's wording.");
      lines.push("Do NOT call plan_edit: it replaces the timeline and would throw away the applied structure. Do not re-cut the source clips.");
    }
  } else {
    lines.push("The reference structure was NOT applied to the timeline.");
    lines.push("Your job this turn: plan the edit from the source footage with plan_edit, and use the reference's measured pacing, rhythm and camera moves as style guidance.");
    lines.push("The reference is never footage to cut. Only media tagged analysisRole=source may be cut.");
  }

  lines.push("Work in ONE turn: apply the edits, then summarize what you changed. Never ask the user which files to use, and never ask for the frame clock — both are already known.");
  lines.push("[/REFERENCE]");
  return lines.join("\n");
}
