import { readText, writeText, ftpReadText, ftpWriteText, loadJson, saveJson } from "$lib/api";
import { basename } from "$lib/format";
import { isFtpPath } from "$lib/ftp";
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
let savedPos: Record<string, EditorPos> | null = null;

/** local or FTP read with the same auto-detect settings */
function readTextAny(path: string) {
  return isFtpPath(path)
    ? ftpReadText(path, "auto", settings.s.fallbackEncoding)
    : readText(path, "auto", settings.s.fallbackEncoding);
}

class EditorStore {
  docs = $state<EditorDoc[]>([]);
  activeId = $state<number | null>(null);
  loading = $state(false);
  viewDocs = $state<ViewerDoc[]>([]);
  activeViewId = $state<number | null>(null);

  /** load remembered caret positions (used when a file is opened again) */
  async init() {
    savedPos = (await loadJson<Record<string, EditorPos>>(POS_FILE).catch(() => null)) ?? {};
  }

  private savedPosFor(path: string): EditorPos | undefined {
    return savedPos?.[path];
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
   *  into editor-state.json, capped, newest first */
  persistAll() {
    if (!savedPos) return;
    for (const d of this.docs) if (d.path && d.pos) savedPos[d.path] = d.pos;
    for (const d of this.viewDocs) if (d.pos) savedPos[d.path] = d.pos;
    const entries = Object.entries(savedPos);
    if (entries.length > POS_MAX) {
      savedPos = Object.fromEntries(entries.slice(entries.length - POS_MAX));
    }
    saveJson(POS_FILE, savedPos).catch(() => {});
  }

  /** keep a position of a doc being closed so a reopen restores it */
  private keepOnClose(path: string | null, pos: EditorPos | undefined) {
    if (path && pos && savedPos) savedPos[path] = pos;
  }

  get active(): EditorDoc | null {
    return this.docs.find((d) => d.id === this.activeId) ?? null;
  }

  get activeViewer(): ViewerDoc | null {
    return this.viewDocs.find((d) => d.id === this.activeViewId) ?? null;
  }

  async open(path: string): Promise<void> {
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

  async newFile(dir?: string): Promise<void> {
    const doc: EditorDoc = {
      id: seq++,
      path: null,
      name: i18n.t("editor.untitled"),
      dirty: false,
      encoding: "utf-8",
      eol: "lf",
      truncated: false,
      text: "",
    };
    // keep optional target dir for first save
    (doc as EditorDoc & { dir?: string }).dir = dir;
    this.docs = [...this.docs, doc];
    this.activeId = doc.id;
    ui.setMode("editor");
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
    const dir = (d as EditorDoc & { dir?: string }).dir;
    const suggestion = d.path ?? (dir ? `${dir}${dir.endsWith("\\") || dir.endsWith("/") ? "" : "/"}new-file.txt` : "new-file.txt");
    const target = await ui.askInput(i18n.t("editor.saveAs"), i18n.t("rename.prompt"), suggestion);
    if (!target) return false;
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
      ui.setMode("viewer");
      return;
    }
    this.loading = true;
    try {
      // images render through the local asset protocol — FTP paths can't use
      // it, so they fall through to the text/hex heuristics below
      const isImage = !isFtpPath(path) && /\.(png|jpe?g|gif|bmp|webp|svg|ico|avif)$/i.test(path);
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
