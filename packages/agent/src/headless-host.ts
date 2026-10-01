import { ActionExecutor } from "@kove-advanced/core/actions/action-executor";
import { ActionHistory } from "@kove-advanced/core/actions/action-history";
import { CAPABILITY_MANIFEST } from "@kove-advanced/core/capabilities/manifest";
import type { CapabilityManifest } from "@kove-advanced/core/capabilities/manifest";
import type { Action, ActionResult } from "@kove-advanced/core/types/actions";
import type { Project } from "@kove-advanced/core/types/project";
import { HistoryLedger, fingerprintProject } from "./checkpoints";
import type { HistoryBackend } from "./checkpoints";
import type { EditingHost, HostFeatures, JobKind, JobResult, JobRunner, OverlayRef, TextOverlayOptions, TxnHandle } from "./host";

export interface HeadlessHostOptions {
  readonly history?: ActionHistory;
  readonly jobRunner?: JobRunner;
}

/**
 * A pure-Node EditingHost. Wraps the core ActionExecutor over an in-memory
 * project so an agent can edit headlessly (cloud / CLI / tests). Rendering and
 * GPU/export jobs are delegated to an injected JobRunner.
 */
export class HeadlessHost implements EditingHost {
  private project: Project | null;
  private readonly executor: ActionExecutor;
  private readonly history: ActionHistory;
  private readonly jobRunner?: JobRunner;
  private txnCounter = 0;
  private readonly txnSnapshots = new Map<string, Project>();
  private readonly ledger: HistoryLedger;
  readonly historyControl: HistoryLedger;

  constructor(project: Project | null, options: HeadlessHostOptions = {}) {
    this.project = project;
    this.history = options.history ?? new ActionHistory();
    this.executor = new ActionExecutor(this.history);
    this.jobRunner = options.jobRunner;
    this.ledger = new HistoryLedger(this.historyBackend());
    this.historyControl = this.ledger;
  }

  features(): HostFeatures {
    const hasRunner = this.jobRunner !== undefined;
    return {
      renderMotionFrame: hasRunner,
      renderTimelineFrame: false,
      renderMulticamPreview: false,
      exportVideo: hasRunner,
      checkpoints: true,
    };
  }

  private historyBackend(): HistoryBackend {
    return {
      position: () => ({ actions: this.history.getUndoStackSize(), aux: 0 }),
      markersAt: (pos) => {
        const entries = this.history.getHistoryEntries();
        if (entries.length < pos.actions) return undefined;
        return [pos.actions === 0 ? null : entries[pos.actions - 1]!.action, null];
      },
      token: () => `${this.history.getRevision()}:${this.history.getUndoStackSize()}:${this.history.getRedoStackSize()}`,
      canUndo: () => this.history.canUndo(),
      canRedo: () => this.history.canRedo(),
      undoStep: () => this.executor.undo(this.getProject()),
      redoStep: () => this.executor.redo(this.getProject()),
      sealGroup: () => this.history.sealGroup(),
      fingerprint: () => fingerprintProject(this.project),
    };
  }

  getProject(): Project {
    this.requireOpenProject();
    return this.project as Project;
  }

  async applyAction(action: Action): Promise<ActionResult> {
    this.requireOpenProject();
    this.ledger.beforeAgentMutation();
    try {
      return await this.executor.execute(action, this.project as Project);
    } finally {
      this.ledger.afterAgentMutation();
    }
  }

  beginTransaction(label?: string): TxnHandle {
    const id = `txn-${++this.txnCounter}`;
    // Snapshot the pre-turn project; rollback restores it wholesale, which is
    // robust to inverse handlers throwing and to history trimming (maxHistorySize)
    // discarding entries mid-turn — both of which can defeat inverse-replay.
    if (this.project) this.txnSnapshots.set(id, structuredClone(this.project));
    this.history.beginGroup(label ?? id);
    return { id };
  }

  commitTransaction(handle: TxnHandle, _label: string): void {
    this.history.endGroup();
    this.txnSnapshots.delete(handle.id);
  }

  async rollbackTransaction(handle: TxnHandle): Promise<void> {
    this.history.endGroup();
    const snapshot = this.txnSnapshots.get(handle.id);
    this.txnSnapshots.delete(handle.id);
    if (snapshot) {
      // Restore the authoritative pre-turn state and drop the turn's history
      // entries so the (errored) turn leaves no partial state and nothing stale
      // to redo.
      this.project = snapshot;
      this.history.clear();
      this.ledger.invalidateAll();
    }
  }

  async runJob(
    kind: JobKind,
    params: Record<string, unknown>,
  ): Promise<JobResult> {
    if (!this.jobRunner) {
      return {
        ok: false,
        error: `Job '${kind}' is not available in this host (no job runner configured)`,
      };
    }
    return this.jobRunner(kind, params);
  }

  capabilities(): CapabilityManifest {
    return CAPABILITY_MANIFEST;
  }

  requireOpenProject(): void {
    if (!this.project) {
      throw new Error("No project is open");
    }
  }

  /** Test/host helper: replace the open project (e.g. after load). */
  setProject(project: Project | null): void {
    this.project = project;
    this.history.clear();
    this.ledger.invalidateAll();
  }

  async createTextOverlay(options: TextOverlayOptions): Promise<OverlayRef> {
    this.requireOpenProject();
    const id = `text-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const trackId = options.trackId ?? "text-track-0";
    const clip = {
      id,
      trackId,
      startTime: options.startSec,
      duration: options.durationSec,
      text: options.text,
      style: (options.style ?? {}) as Record<string, unknown>,
      transform: {
        position: options.position
          ? { x: options.position.x, y: options.position.y }
          : { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      keyframes: [],
    };
    const result = await this.applyAction({
      type: "text/create",
      id: `create-${id}`,
      timestamp: Date.now(),
      params: { clip },
    });
    if (!result.success) throw new Error(result.error?.message ?? "Failed to create text overlay");
    return { id, trackId };
  }

  async removeOverlay(kind: string, id: string): Promise<boolean> {
    this.requireOpenProject();
    const result = await this.applyAction({
      type: `${kind}/remove`,
      id: `remove-${id}`,
      timestamp: Date.now(),
      params: { clipId: id },
    });
    return result.success;
  }
}
