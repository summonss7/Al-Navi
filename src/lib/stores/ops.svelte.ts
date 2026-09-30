import {
  copyPaths,
  movePaths,
  deletePaths,
  opControl,
  onOpProgress,
  onOpConflict,
  resolveConflict,
} from "$lib/api";
import type { ConflictInfo, OpError, OpProgress } from "$lib/types";
import { panels } from "./panels.svelte";
import { ui } from "./ui.svelte";
import { i18n } from "./i18n.svelte";

export interface ActiveOp extends OpProgress {
  title: string;
  paused: boolean;
}

class OpsStore {
  op = $state<ActiveOp | null>(null);
  background = $state(false);
  private unlistens: (() => void)[] = [];

  init() {
    onOpProgress((p) => this.onProgress(p)).then((u) => this.unlistens.push(u));
    onOpConflict((c) => this.onConflict(c)).then((u) => this.unlistens.push(u));
  }

  dispose() {
    this.unlistens.forEach((u) => u());
  }

  private onProgress(p: OpProgress) {
    if (!this.op || this.op.id !== p.id) {
      if (p.phase !== "done") return;
      return;
    }
    if (p.phase === "done") {
      // keep result visible until user closes (or auto-close when clean)
      this.op = { ...this.op, ...p, paused: false };
      if (!p.cancelled && p.errors.length === 0) {
        // auto-close clean operations after a beat
        setTimeout(() => {
          if (this.op?.phase === "done" && !this.op.cancelled && this.op.errors.length === 0) {
            this.finishOp();
          }
        }, 600);
      }
      panels.active.refresh();
      panels.inactive.refresh();
    } else {
      this.op = { ...this.op, ...p };
    }
  }

  finishOp() {
    this.op = null;
    this.background = false;
    if (ui.dialog === "progress") ui.closeDialog();
  }

  conflict = $state<ConflictInfo | null>(null);

  private onConflict(c: ConflictInfo) {
    if (!this.op || this.op.id !== c.id) return;
    this.conflict = c;
    ui.openDialog("conflict");
  }

  resolveConflictAction(action: string) {
    if (!this.conflict) return;
    resolveConflict(this.conflict.id, action).catch(console.error);
    this.conflict = null;
    ui.closeDialog();
    if (!this.background) ui.openDialog("progress");
  }

  private begin(title: string): number | null {
    // placeholder id is replaced on first progress event; use -1 temporarily
    this.op = {
      id: -1,
      title,
      phase: "scan",
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      current: "",
      speed: 0,
      cancelled: false,
      errors: [],
      paused: false,
    };
    this.background = false;
    this.conflict = null;
    return null;
  }

  async startCopy(paths: string[], dest: string) {
    this.begin(i18n.t("ops.copy"));
    ui.openDialog("progress");
    try {
      const id = await copyPaths(paths, dest);
      if (this.op) this.op.id = id;
    } catch (e) {
      this.op = { ...this.op!, phase: "done", errors: [{ path: "", error: String(e) }] };
    }
  }

  async startMove(paths: string[], dest: string) {
    this.begin(i18n.t("ops.move"));
    ui.openDialog("progress");
    try {
      const id = await movePaths(paths, dest);
      if (this.op) this.op.id = id;
    } catch (e) {
      this.op = { ...this.op!, phase: "done", errors: [{ path: "", error: String(e) }] };
    }
  }

  async startDelete(paths: string[], permanent: boolean) {
    this.begin(permanent ? i18n.t("ops.deletePermanent") : i18n.t("ops.delete"));
    ui.openDialog("progress");
    try {
      const id = await deletePaths(paths, permanent);
      if (this.op) this.op.id = id;
    } catch (e) {
      this.op = { ...this.op!, phase: "done", errors: [{ path: "", error: String(e) }] };
    }
  }

  pauseOrResume() {
    if (!this.op || this.op.phase === "done") return;
    const paused = !this.op.paused;
    opControl(this.op.id, paused ? "pause" : "resume").catch(console.error);
    this.op = { ...this.op, paused };
  }

  cancel() {
    if (!this.op) return;
    if (this.op.phase === "done") {
      this.finishOp();
      return;
    }
    opControl(this.op.id, "cancel").catch(console.error);
  }

  toBackground() {
    this.background = true;
    if (ui.dialog === "progress") ui.closeDialog();
  }

  openProgress() {
    if (this.op) {
      this.background = false;
      ui.openDialog("progress");
    }
  }
}

export const ops = new OpsStore();
