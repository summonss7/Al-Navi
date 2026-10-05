import { readText, writeText, ftpReadText, ftpWriteText, archiveReadText, loadJson, saveJson, pathExists } from "$lib/api";
import { basename, isAbsolutePath, joinPath } from "$lib/format";
import { isFtpPath } from "$lib/ftp";
import { isArchivePath } from "$lib/archive";
import { ui } from "./ui.svelte";
import { i18n } from "./i18n.svelte";
import { settings } from "./settings.svelte";
import type { EditorPos } from "$lib/editor/cm";

export interface EditorDoc {
  id: number;
  path: string | null;
  name: string;
  dirty: boolean;
  encoding: string;
  eol: string;
  truncated: boolean;
  /** CodeMirror Text state — non-reactive, lives outside Svelte */
  text: string;
  /** remembered caret/scroll — restored on tab switch and remount */
  pos?: EditorPos;
}

export interface ViewerDoc {
  id: number;
  path: string;
  name: string;
  mode: "text" | "hex" | "image";
  encoding: string;
  eol: string;
  truncated: boolean;
  text: string;
  pos?: EditorPos;
}

let seq = 1;

/** last known positions per file path, persisted across restarts */
const POS_FILE = "editor-state.json";
const POS_MAX = 100;

/** Alt+F11 view history, persisted like dir-history */
const VIEW_HIST_FILE = "view-history.json";
const VIEW_HIST_MAX = 100;
/** persisted entry with a recency stamp — a plain position record is the
 *  pre-1.7.1 format; the stamp keeps the trim below truly newest-first
 *  (Rust's serde round-trip re-orders JSON object keys alphabetically) */
interface SavedEntry {
  pos: EditorPos;
  ts: number;
}
let savedPos: Record<string, SavedEntry> | null = null;

/** local, FTP or archive-member read with the same auto-detect settings */
function readTextAny(path: string) {
  if (isFtpPath(path)) return ftpReadText(path, "auto", settings.s.fallbackEncoding);
  if (isArchivePath(path)) return archiveReadText(path, "auto", settings.s.fallbackEncoding);
  return readText(path, "auto", settings.s.fallbackEncoding);
}

class EditorStore {
  docs = $state<EditorDoc[]>([]);
  activeId = $state<number | null>(null);
  loading = $state(false);
  viewDocs = $state<ViewerDoc[]>([]);
  activeViewId = $state<number | null>(null);
  /** paths of previously viewed files, newest first (Alt+F11) */
  viewHistory = $state<string[]>([]);

  /** load remembered caret positions (used when a file is opened again) */
  async init() {
    const raw = await loadJson<Record<string, EditorPos | SavedEntry>>(POS_FILE).catch(() => null);
    savedPos = {};
    if (raw) {
      for (const [k, v] of Object.entries(raw)) {
        // entries without a stamp are the pre-1.7.1 bare-position format
        savedPos[k] = v && typeof (v as SavedEntry).ts === "number" && (v as SavedEntry).pos
          ? (v as SavedEntry)
          : { pos: v as EditorPos, ts: 0 };
      }
    }
    const vh = await loadJson<string[]>(VIEW_HIST_FILE).catch(() => null);
    this.viewHistory = vh ?? [];
  }

  /** record a view in the Alt+F11 history: dedupe, newest first, capped */
  pushViewHistory(path: string) {
    this.viewHistory = [path, ...this.viewHistory.filter((p) => p !== path)].slice(0, VIEW_HIST_MAX);
    saveJson(VIEW_HIST_FILE, this.viewHistory).catch(() => {});
  }

  private savedPosFor(path: string): EditorPos | undefined {
    return savedPos?.[path]?.pos;
  }

  /** remember the caret/scroll of an open editor doc (tab switch / remount) */
  savePos(id: number, pos: EditorPos) {
    const d = this.docs.find((x) => x.id === id);
    if (d) d.pos = pos;
  }

  /** same for a viewer doc */
  saveViewPos(id: number, pos: EditorPos) {
    const d = this.viewDocs.find((x) => x.id === id);
    if (d) d.pos = pos;
  }

  /** merge the positions of everything still open (plus recently closed ones)
   *  into editor-state.json, keeping the most recent POS_MAX paths */
  async persistAll(): Promise<void> {
    if (!savedPos) return;
    const now = Date.now();
    for (const d of this.docs) if (d.path && d.pos) savedPos[d.path] = { pos: d.pos, ts: now };
    for (const d of this.viewDocs) if (d.pos) savedPos[d.path] = { pos: d.pos, ts: now };
    const entries = Object.entries(savedPos);
    if (entries.length > POS_MAX) {
      entries.sort((a, b) => b[1].ts - a[1].ts);
      savedPos = Object.fromEntries(entries.slice(0, POS_MAX));
    }
    await saveJson(POS_FILE, savedPos).catch(() => {});
  }

  /** keep a position of a doc being closed so a reopen restores it */
  private keepOnClose(path: string | null, pos: EditorPos | undefined) {
    if (path && pos && savedPos) savedPos[path] = { pos, ts: Date.now() };
  }

  get active(): EditorDoc | null {
    return this.docs.find((d) => d.id === this.activeId) ?? null;
  }

  get activeViewer(): ViewerDoc | null {
    return this.viewDocs.find((d) => d.id === this.activeViewId) ?? null;
  }

  async open(path: string): Promise<void> {
    // archive members are read-only for the VFS — no repacking from the editor
    if (isArchivePath(path)) {
      ui.showToast(i18n.t("archive.readonly"));
      return;
    }
    const existing = this.docs.find((d) => d.path === path);
    if (existing) {
      this.activate(existing.id);
      ui.setMode("editor");
      return;
    }
    this.loading = true;
    try {
      const c = await readTextAny(path);
      const doc: EditorDoc = {
        id: seq++,
        path,
        name: basename(path),
        dirty: false,
        encoding: c.encoding,
        eol: c.eol === "mixed" ? "keep" : c.eol,
        truncated: c.truncated,
        text: c.text,
        pos: this.savedPosFor(path),
      };
      this.docs = [...this.docs, doc];
      this.activeId = doc.id;
      ui.setMode("editor");
    } catch (e) {
      ui.showError(String(e));
    } finally {
      this.loading = false;
    }
  }

  /** Shift+F4 (FAR-style): ask for the name up front with an empty field,
   *  create the empty file right in the given directory (or wherever the
   *  entered absolute path points) and open it; an existing file just opens */
  async newFile(dir?: string): Promise<void> {
    const name = await ui.askInput(i18n.t("editor.newFileTitle"), i18n.t("editor.fileNamePrompt"), "");
    const trimmed = name?.trim();
    if (!trimmed) return;
    const target = isAbsolutePath(trimmed) || isFtpPath(trimmed) ? trimmed : joinPath(dir ?? "", trimmed);
    try {
      if (!isFtpPath(target) && await pathExists(target)) {
        await this.open(target);
        return;
      }
      if (isFtpPath(target)) await ftpWriteText(target, "", "utf-8", "lf");
      else await writeText(target, "", "utf-8", "lf");
      const doc: EditorDoc = {
        id: seq++,
        path: target,
        name: basename(target),
        dirty: false,
        encoding: "utf-8",
        eol: "lf",
        truncated: false,
        text: "",
        pos: this.savedPosFor(target),
      };
      this.docs = [...this.docs, doc];
      this.activeId = doc.id;
      ui.setMode("editor");
    } catch (e) {
      ui.showError(String(e));
    }
  }

  activate(id: number) {
    if (this.docs.some((d) => d.id === id)) {
      this.activeId = id;
      ui.setMode("editor");
    } else if (this.viewDocs.some((d) => d.id === id)) {
      this.activeViewId = id;
      ui.setMode("viewer");
    }
  }

  cycle(dir: 1 | -1) {
    // cycle among editor docs first, then viewers, then panels (FAR-ish window cycling)
    if (ui.mode === "editor" && this.docs.length > 0) {
      const idx = this.docs.findIndex((d) => d.id === this.activeId);
      const next = this.docs[(idx + dir + this.docs.length) % this.docs.length];
      this.activeId = next.id;
    } else if (ui.mode === "viewer" && this.viewDocs.length > 0) {
      const idx = this.viewDocs.findIndex((d) => d.id === this.activeViewId);
      const next = this.viewDocs[(idx + dir + this.viewDocs.length) % this.viewDocs.length];
      this.activeViewId = next.id;
    } else if (this.docs.length + this.viewDocs.length > 0) {
      // from panels: go to most recent document type
      if (this.docs.length) {
        this.activeId = this.docs[this.docs.length - 1].id;
        ui.setMode("editor");
      } else {
        this.activeViewId = this.viewDocs[this.viewDocs.length - 1].id;
        ui.setMode("viewer");
      }
    }
  }

  markDirty(id: number, dirty: boolean) {
    const d = this.docs.find((x) => x.id === id);
    if (d) d.dirty = dirty;
  }

  /** replace stored text (called on CodeMirror doc change, throttled by component) */
  setText(id: number, text: string) {
    const d = this.docs.find((x) => x.id === id);
    if (d) d.text = text;
  }

  setEncoding(id: number, enc: string) {
    const d = this.docs.find((x) => x.id === id);
    if (d) d.encoding = enc;
  }

  async save(id = this.activeId): Promise<boolean> {
    const d = this.docs.find((x) => x.id === id);
    if (!d) return false;
    if (!d.path) return this.saveAs(id);
    try {
      if (isFtpPath(d.path)) {
        await ftpWriteText(d.path, d.text, d.encoding, d.eol);
      } else {
        await writeText(d.path, d.text, d.encoding, d.eol);
      }
      d.dirty = false;
      return true;
    } catch (e) {
      ui.showError(String(e));
      return false;
    }
  }

  async saveAs(id = this.activeId): Promise<boolean> {
    const d = this.docs.find((x) => x.id === id);
    if (!d) return false;
    const oldPath = d.path;
    const target = await ui.askInput(i18n.t("editor.saveAs"), i18n.t("rename.prompt"), oldPath ?? "new-file.txt");
    if (!target) return false;
    // carry the remembered caret position over to the new path
    if (savedPos && oldPath && oldPath !== target && savedPos[oldPath]) {
      savedPos[target] = savedPos[oldPath];
      delete savedPos[oldPath];
    }
    d.path = target;
    d.name = basename(target);
    return this.save(id);
  }

  async close(id = this.activeId) {
    const d = this.docs.find((x) => x.id === id);
    if (!d) return;
    if (d.dirty) {
      const yes = await ui.askConfirm(i18n.t("editor.saveChanges", { name: d.name }));
      if (yes) {
        const ok = await this.save(id);
        if (!ok) return;
      }
    }
    this.keepOnClose(d.path, d.pos);
    this.persistAll();
    this.docs = this.docs.filter((x) => x.id !== id);
    if (this.activeId === id) {
      const rest = this.docs[this.docs.length - 1];
      if (rest) this.activeId = rest.id;
      else {
        this.activeId = null;
        ui.setMode(this.viewDocs.length ? "viewer" : "panels");
      }
    }
  }

  // ---------- viewer ----------

  async view(path: string): Promise<void> {
    const existing = this.viewDocs.find((d) => d.path === path);
    if (existing) {
      this.activeViewId = existing.id;
      this.pushViewHistory(path);
      ui.setMode("viewer");
      return;
    }
    this.loading = true;
    try {
      // images render through the local asset protocol — FTP and archive
      // paths can't use it, so they fall through to the text/hex heuristics
      const virtual = isFtpPath(path) || isArchivePath(path);
      const isImage = !virtual && /\.(png|jpe?g|gif|bmp|webp|svg|ico|avif)$/i.test(path);
      let doc: ViewerDoc;
      if (isImage) {
        doc = {
          id: seq++,
          path,
          name: basename(path),
          mode: "image",
          encoding: "",
          eol: "",
          truncated: false,
          text: "",
        };
      } else {
        const c = await readTextAny(path);
        // binary heuristics: many replacement chars or NULs -> hex
        // eslint-disable-next-line no-control-regex -- управляющие символы здесь ищем намеренно
        const bin = /[\u0000\u0001\u0002]/.test(c.text.slice(0, 4096));
        doc = {
          id: seq++,
          path,
          name: basename(path),
          mode: bin ? "hex" : "text",
          encoding: c.encoding,
          eol: c.eol,
          truncated: c.truncated,
          text: bin ? "" : c.text,
          pos: this.savedPosFor(path),
        };
      }
      this.viewDocs = [...this.viewDocs, doc];
      this.activeViewId = doc.id;
      this.pushViewHistory(path);
      ui.setMode("viewer");
    } catch (e) {
      ui.showError(String(e));
    } finally {
      this.loading = false;
    }
  }

  toggleHexActive() {
    const d = this.activeViewer;
    if (!d) return;
    d.mode = d.mode === "hex" ? "text" : "hex";
    if (d.mode === "text" && !d.text) {
      readTextAny(d.path).then((c) => {
        d.text = c.text;
        d.encoding = c.encoding;
      });
    }
  }

  async closeViewer(id = this.activeViewId) {
    const d = this.viewDocs.find((x) => x.id === id);
    this.keepOnClose(d?.path ?? null, d?.pos);
    this.persistAll();
    this.viewDocs = this.viewDocs.filter((x) => x.id !== id);
    if (this.activeViewId === id) {
      const rest = this.viewDocs[this.viewDocs.length - 1];
      if (rest) this.activeViewId = rest.id;
      else {
        this.activeViewId = null;
        ui.setMode(this.docs.length ? "editor" : "panels");
      }
    }
  }

  toEditorActive() {
    const d = this.activeViewer;
    if (d) void this.open(d.path).then(() => void this.closeViewer(d.id));
  }
}

export const editor = new EditorStore();
