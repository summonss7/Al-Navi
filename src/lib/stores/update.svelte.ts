// Update channel state (alnavi-039): silent check at startup (at most once
// a day, lastCheck persisted in update-state.json) + the manual «Проверить
// обновления» in the F9 menu. An available update opens the dialog (the
// banner); an unreachable center degrades silently — "не удалось проверить"
// is not an error (UPDATES-SYSTEM §5).
import {
  loadJson,
  saveJson,
  updaterCheck,
  updaterDownload,
  updaterApply,
  onUpdaterProgress,
  type UpdateAsset,
  type UpdateCheck,
} from "$lib/api";
import { ui } from "./ui.svelte";
import { panels } from "./panels.svelte";
import { editor } from "./editor.svelte";
import { windowState } from "$lib/windowState";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "downloading"
  | "restarting"
  | "error";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = "update-state.json";

class UpdateStore {
  status = $state<UpdateStatus>("idle");
  current = $state("");
  latest = $state<string | null>(null);
  notes = $state<string | null>(null);
  publishedAt = $state<string | null>(null);
  asset = $state<UpdateAsset | null>(null);
  downloaded = $state(0);
  total = $state(0);
  error = $state<string | null>(null);
  private busy = false;
  private lastCheck: number | null = null;
  private progressHooked = false;

  /** App startup hook: subscribe to download progress and run the silent
   *  daily check (App.svelte onMount). */
  async init() {
    const st = await loadJson<{ lastCheck: number }>(STATE_FILE).catch(() => null);
    this.lastCheck = st?.lastCheck ?? null;
    void this.hookProgress();
    if (this.lastCheck === null || Date.now() - this.lastCheck > DAY_MS) {
      await this.check(false);
    }
  }

  /** Check the channel manifest. Manual = always open the dialog and show
   *  the outcome; silent = only an available update surfaces (as the
   *  dialog), everything else stays quiet. */
  async check(manual: boolean) {
    if (this.busy) return;
    this.busy = true;
    if (manual) {
      this.status = "checking";
      this.error = null;
      ui.openDialog("update");
    }
    const r: UpdateCheck = await updaterCheck().catch((e) => ({
      status: "network-error" as const,
      current: this.current,
      latest: null,
      notes: null,
      publishedAt: null,
      asset: null,
      error: String(e),
    }));
    this.current = r.current;
    this.latest = r.latest;
    this.notes = r.notes;
    this.publishedAt = r.publishedAt;
    this.asset = r.asset;
    this.lastCheck = Date.now();
    void saveJson(STATE_FILE, { lastCheck: this.lastCheck }).catch(() => {});
    this.busy = false;
    if (r.status === "available") {
      this.status = "available";
      if (!manual) ui.openDialog("update");
      return;
    }
    this.status = manual ? (r.status === "latest" ? "latest" : "error") : "idle";
    this.error = r.status === "latest" ? null : r.error;
  }

  /** «Обновить»: download (sha256 verified in the backend) → persist the
   *  session the way the close handlers do → rename-swap + restart. */
  async install() {
    const a = this.asset;
    if (!a?.sha256) return;
    this.status = "downloading";
    this.downloaded = 0;
    this.total = a.size ?? 0;
    try {
      const tmp = await updaterDownload(a.url, a.sha256, a.size ?? 0);
      this.status = "restarting";
      // updater_apply exits the process: the normal close handlers never
      // run, so persist everything first (same trio as app.quit)
      panels.saveSession();
      await editor.persistAll();
      await windowState.flush();
      await updaterApply(tmp);
      // on success the app restarts; a return here means apply failed -> catch
    } catch (e) {
      this.status = "error";
      this.error = String(e);
    }
  }

  private async hookProgress() {
    if (this.progressHooked) return;
    try {
      await onUpdaterProgress((p) => {
        this.downloaded = p.downloaded;
        if (p.total) this.total = p.total;
      });
      // mark hooked only on success: a failed listen (no backend yet) retries
      // on the next init instead of muting progress forever
      this.progressHooked = true;
    } catch {
      /* no Tauri backend (browser preview) — no progress events */
    }
  }
}

export const update = new UpdateStore();
