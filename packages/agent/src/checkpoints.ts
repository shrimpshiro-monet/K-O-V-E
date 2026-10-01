import type { ActionResult } from "@kove-advanced/core/types/actions";
import type {
  CheckpointInfo,
  HistoryControl,
  HistoryOpResult,
  HistoryOptions,
} from "./host";

/**
 * Agent-safe undo/redo + checkpoints, shared by every EditingHost.
 *
 * Design notes
 * - A checkpoint stores NO copy of the project. It records the undo-stack
 *   position plus identity markers of the entries at that position, and restore
 *   replays the host's normal undo path until the position matches. (The project
 *   is mutated in place, so structural sharing is not available; replay keeps
 *   the cost proportional to the work being reverted and, importantly, goes
 *   through the same engine-syncing undo the UI uses.)
 * - Restore is verified with a project fingerprint, so an inexact replay is
 *   reported instead of silently trusted.
 * - Human-safety is observation based: the host reports when the agent mutates
 *   (before/afterAgentMutation). If the history changed in between, a human
 *   (or something else) edited, and agent undo/redo/restore refuse unless forced.
 *   Limitation: a human edit made *while* an agent mutation is awaiting
 *   completion is attributed to the agent.
 */

export interface HistoryPosition {
  /** Depth of the action undo stack. */
  readonly actions: number;
  /** Depth of any auxiliary undo stacks (live editor: overlay-clip + template stacks). */
  readonly aux: number;
  /**
   * Backend-private breakdown (e.g. per-stack depths) handed back to
   * markersAt(). The ledger only compares `actions` and `aux`.
   */
  readonly detail?: unknown;
}

export interface HistoryBackend {
  position(): HistoryPosition;
  /**
   * Identity markers of the entries at depth-1 of the [action, aux] stacks.
   * `undefined` when either stack is shallower than `pos`. A marker must
   * survive an undo→redo round trip of its entry.
   */
  markersAt(pos: HistoryPosition): readonly unknown[] | undefined;
  /** Opaque value that differs whenever any undo/redo-relevant state changed. */
  token(): string;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Undo one step through the host's normal (engine-syncing) path. */
  undoStep(): Promise<ActionResult>;
  redoStep(): Promise<ActionResult>;
  /** Force an undo-group boundary at the current position. */
  sealGroup(): void;
  /** Stable hash of project content, ignoring volatile fields like modifiedAt. */
  fingerprint(): string;
}

interface StoredCheckpoint {
  readonly info: CheckpointInfo;
  readonly position: HistoryPosition;
  readonly markers: readonly unknown[];
  readonly fingerprint: string;
  humanEdited: boolean;
}

const total = (p: HistoryPosition): number => p.actions + p.aux;

const sameMarkers = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((m, i) => Object.is(m, b[i]));

export class HistoryLedger implements HistoryControl {
  private readonly checkpoints = new Map<string, StoredCheckpoint>();
  private seq = 0;
  private counter = 0;
  private lastToken: string;
  /** Token right after the agent's last mutation/undo/redo; null before any agent activity. */
  private lastAgentToken: string | null = null;
  /** Undo depth (total) at which the agent's own entries begin. */
  private floor = 0;
  /** True while the redo stack holds only entries the agent undid. */
  private redoOwned = false;

  constructor(private readonly backend: HistoryBackend) {
    this.lastToken = backend.token();
  }

  // ---- host hooks ---------------------------------------------------------

  /** Call immediately before the agent mutates the project. */
  beforeAgentMutation(): void {
    const token = this.backend.token();
    if (this.lastAgentToken === null) {
      this.floor = total(this.backend.position());
    } else if (token !== this.lastAgentToken) {
      this.noteHumanEdit();
    }
  }

  /** Call after an agent mutation. `kind: "history"` leaves the redo stack owned (undo/restore). */
  afterAgentMutation(kind: "mutation" | "history" = "mutation"): void {
    this.lastAgentToken = this.backend.token();
    if (kind === "mutation") this.redoOwned = false;
  }

  /** Forget everything (project replaced or history cleared). */
  invalidateAll(): void {
    this.checkpoints.clear();
    this.lastAgentToken = null;
    this.redoOwned = false;
    this.floor = total(this.backend.position());
  }

  // ---- HistoryControl -----------------------------------------------------

  revision(): number {
    const token = this.backend.token();
    if (token !== this.lastToken) {
      this.lastToken = token;
      this.counter += 1;
    }
    return this.counter;
  }

  createCheckpoint(label?: string): CheckpointInfo {
    this.beforeAgentMutation();
    this.backend.sealGroup();
    const position = this.backend.position();
    const markers = this.backend.markersAt(position) ?? [];
    this.seq += 1;
    const id = `cp-${this.seq}`;
    const info: CheckpointInfo = {
      id,
      label: label?.trim() || id,
      createdAt: new Date().toISOString(),
      revision: this.revision(),
      undoDepth: total(position),
    };
    this.checkpoints.set(id, {
      info,
      position,
      markers,
      fingerprint: this.backend.fingerprint(),
      humanEdited: false,
    });
    this.afterAgentMutation("history");
    return info;
  }

  listCheckpoints(): readonly CheckpointInfo[] {
    return [...this.checkpoints.values()]
      .filter((cp) => this.isIntact(cp))
      .map((cp) => cp.info);
  }

  async undo(options: HistoryOptions = {}): Promise<HistoryOpResult> {
    if (!this.backend.canUndo()) {
      return this.fail("NOTHING_TO_UNDO", "There is nothing to undo.");
    }
    if (!options.force && !this.agentOwnsTop()) {
      return this.fail(
        "HUMAN_EDITS_PRESENT",
        "The most recent undoable step is not the agent's own (the user edited, or the agent has made no changes).",
        "Undo only reverts the agent's own work. Pass force:true to also undo user edits, or leave them as they are.",
      );
    }
    const before = this.backend.position();
    const result = await this.backend.undoStep();
    if (!result.success) {
      return this.fail("UNDO_FAILED", result.error?.message ?? "Undo failed.");
    }
    this.afterAgentMutation("history");
    this.redoOwned = true;
    if (total(this.backend.position()) < this.floor) this.floor = total(this.backend.position());
    return this.ok("Undid the last step.", [], total(before) - total(this.backend.position()));
  }

  async redo(options: HistoryOptions = {}): Promise<HistoryOpResult> {
    if (!this.backend.canRedo()) {
      return this.fail("NOTHING_TO_REDO", "There is nothing to redo.");
    }
    const humanChanged =
      this.lastAgentToken === null || this.backend.token() !== this.lastAgentToken;
    if (!options.force && (!this.redoOwned || humanChanged)) {
      return this.fail(
        "HUMAN_EDITS_PRESENT",
        "The redo stack holds steps the agent did not undo itself.",
        "Pass force:true to redo them anyway.",
      );
    }
    const before = this.backend.position();
    const result = await this.backend.redoStep();
    if (!result.success) {
      return this.fail("REDO_FAILED", result.error?.message ?? "Redo failed.");
    }
    this.afterAgentMutation("history");
    return this.ok("Redid the last undone step.", [], total(this.backend.position()) - total(before));
  }

  async restoreCheckpoint(id: string, options: HistoryOptions = {}): Promise<HistoryOpResult> {
    const cp = this.checkpoints.get(id);
    if (!cp) {
      return this.fail(
        "CHECKPOINT_NOT_FOUND",
        `No checkpoint with id '${id}'.`,
        "Call list_checkpoints to see valid ids.",
      );
    }
    if (!this.isIntact(cp)) {
      this.checkpoints.delete(id);
      return this.fail(
        "CHECKPOINT_STALE",
        `Checkpoint '${cp.info.label}' can no longer be restored: the history it points into was undone below it, replaced, or trimmed.`,
        "Create a new checkpoint from the current state.",
      );
    }
    const humanDirty =
      cp.humanEdited ||
      (this.lastAgentToken !== null && this.backend.token() !== this.lastAgentToken);
    if (humanDirty && !options.force) {
      return this.fail(
        "HUMAN_EDITS_PRESENT",
        `The user edited the project after checkpoint '${cp.info.label}'. Restoring would discard those edits too.`,
        "Ask the user, then retry with force:true — or keep the current state and fix forward.",
      );
    }

    const warnings: string[] = [];
    if (humanDirty) warnings.push("force: user edits made after the checkpoint were reverted as well.");

    const target = total(cp.position);
    let steps = 0;
    const guard = total(this.backend.position()) - target + 2;
    while (total(this.backend.position()) > target) {
      if (steps >= guard) break;
      const res = await this.backend.undoStep();
      if (!res.success) {
        this.afterAgentMutation("history");
        return this.fail(
          "RESTORE_INCOMPLETE",
          `Undo failed after ${steps} step(s): ${res.error?.message ?? "unknown error"}. The project is partially restored.`,
          "Call undo to step back manually, or restore a different checkpoint.",
          warnings,
          steps,
        );
      }
      steps += 1;
    }

    const now = this.backend.position();
    this.afterAgentMutation("history");
    this.redoOwned = true;
    if (total(now) < this.floor) this.floor = total(now);

    if (now.actions !== cp.position.actions || now.aux !== cp.position.aux) {
      return this.fail(
        "RESTORE_INCOMPLETE",
        `Restore stopped at undo depth ${total(now)} (checkpoint is ${target}); the checkpoint boundary was not a clean undo-group boundary.`,
        total(now) < target ? "Call redo to step forward." : "Call undo to continue stepping back.",
        warnings,
        steps,
      );
    }

    // Checkpoints above this one no longer exist in the timeline's past.
    for (const [otherId, other] of this.checkpoints) {
      if (total(other.position) > target) this.checkpoints.delete(otherId);
    }
    cp.humanEdited = false;

    const verified = this.backend.fingerprint() === cp.fingerprint;
    if (!verified) {
      warnings.push(
        "The restored project does not match the checkpoint's fingerprint. Some changes (for example overlays created outside the undo history) may not have been reverted. Inspect with get_editor_state before continuing.",
      );
    }
    return {
      ...this.ok(`Restored checkpoint '${cp.info.label}'.`, warnings, steps),
      verified,
    };
  }

  // ---- internals ----------------------------------------------------------

  private noteHumanEdit(): void {
    this.floor = total(this.backend.position());
    this.redoOwned = false;
    for (const cp of this.checkpoints.values()) cp.humanEdited = true;
    // Re-baseline so one human edit is reported once.
    this.lastAgentToken = this.backend.token();
  }

  private agentOwnsTop(): boolean {
    return (
      this.lastAgentToken !== null &&
      this.backend.token() === this.lastAgentToken &&
      total(this.backend.position()) > this.floor
    );
  }

  private isIntact(cp: StoredCheckpoint): boolean {
    const markers = this.backend.markersAt(cp.position);
    return markers !== undefined && sameMarkers(markers, cp.markers);
  }

  private ok(message: string, warnings: readonly string[], steps: number): HistoryOpResult {
    return {
      ok: true,
      message,
      warnings,
      undoDepth: total(this.backend.position()),
      revision: this.revision(),
      steps,
    };
  }

  private fail(
    code: NonNullable<HistoryOpResult["code"]>,
    message: string,
    suggestedFix?: string,
    warnings: readonly string[] = [],
    steps?: number,
  ): HistoryOpResult {
    return {
      ok: false,
      code,
      message,
      ...(suggestedFix ? { suggestedFix } : {}),
      warnings,
      undoDepth: total(this.backend.position()),
      revision: this.revision(),
      ...(steps !== undefined ? { steps } : {}),
    };
  }
}

// ---- fingerprinting ---------------------------------------------------------

const VOLATILE_KEYS = new Set(["modifiedAt"]);

function canon(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? String(value) : `#${String(value)}`;
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t !== "object") return "f";
  const obj = value as object;
  if (typeof Blob !== "undefined" && obj instanceof Blob) return `blob:${obj.size}`;
  if (ArrayBuffer.isView(obj)) return `view:${obj.byteLength}`;
  if (obj instanceof ArrayBuffer) return `buf:${obj.byteLength}`;
  if (seen.has(obj)) return "cycle";
  seen.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    out = `[${obj.map((v) => canon(v, seen)).join(",")}]`;
  } else {
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter(
        (k) =>
          !VOLATILE_KEYS.has(k) &&
          rec[k] !== undefined &&
          typeof rec[k] !== "function" &&
          // Undo materializes optional collections as [] where the original
          // had none; absent and empty are the same project state.
          !(Array.isArray(rec[k]) && (rec[k] as unknown[]).length === 0),
      )
      .sort();
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${canon(rec[k], seen)}`).join(",")}}`;
  }
  seen.delete(obj);
  return out;
}

/**
 * Stable content hash of a project (or any JSON-like value): key order,
 * `modifiedAt`, and absent-vs-empty-array do not matter. Two independent 32-bit FNV-1a-style passes, so an
 * accidental collision is ~2^-64.
 */
export function fingerprintProject(project: unknown): string {
  const s = canon(project, new WeakSet());
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}:${s.length}`;
}
