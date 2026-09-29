import { registerCommand } from "$lib/commands";
import { mkdir, renamePath, openPath, homePath } from "$lib/api";
import { joinPath, sortArrow } from "$lib/format";
import { panels } from "$lib/stores/panels.svelte";
import { ui } from "$lib/stores/ui.svelte";
import { editor } from "$lib/stores/editor.svelte";
import { ops } from "$lib/stores/ops.svelte";
import { i18n } from "$lib/stores/i18n.svelte";
import { settings } from "$lib/stores/settings.svelte";
import { cmdline } from "$lib/stores/cmdline.svelte";

export function registerAllCommands() {
  const A = () => panels.active;

  // ---------- panels ----------
  registerCommand("panel.switchActive", () => panels.switchActive());
  registerCommand("panel.drivesLeft", () => {
    ui.drivesFor = "left";
    ui.openDialog("drives");
  });
  registerCommand("panel.drivesRight", () => {
    ui.drivesFor = "right";
    ui.openDialog("drives");
  });
  registerCommand("panel.toggleLeft", () => panels.toggleSide("left"));
  registerCommand("panel.toggleRight", () => panels.toggleSide("right"));
  registerCommand("panel.hideBoth", () => panels.hideBoth());
  registerCommand("panel.showBoth", () => panels.showBoth());
  registerCommand("panel.swap", () => panels.swap());
  registerCommand("panel.enter", () => void A().enter());
  registerCommand("panel.intoDir", () => void A().intoDir());
  registerCommand("panel.up", () => void A().up());
  registerCommand("panel.root", () => void A().root());
  registerCommand("panel.refresh", () => A().refresh());
  registerCommand("panel.toggleHidden", () => {
    // global setting: both panels rebuild and it persists
    settings.set({ showHidden: !settings.s.showHidden });
    panels.refreshView();
  });
  registerCommand("panel.escape", () => {
    const p = A();
    if (p.quickJumpPrefix !== null) {
      p.clearQuickJump();
    } else {
      p.clearSelection();
    }
  });
  registerCommand("panel.selectCursor", () => A().toggleAt(A().cursor));
  registerCommand("panel.selectGroup", async () => {
    const mask = await ui.askInput(i18n.t("panel.quickSearch"), i18n.t("common.name"), "*");
    if (mask === null) return;
    A().selectByMask(mask || "*", true);
  });
  registerCommand("panel.deselectGroup", async () => {
    const mask = await ui.askInput(i18n.t("panel.quickSearch"), i18n.t("common.name"), "*");
    if (mask === null) return;
    A().selectByMask(mask || "*", false);
  });
  registerCommand("panel.invertSelection", () => A().invertSelection());
  registerCommand("panel.sortName", () => setSort("name"));
  registerCommand("panel.sortExt", () => setSort("ext"));
  registerCommand("panel.sortMtime", () => setSort("mtime"));
  registerCommand("panel.sortSize", () => setSort("size"));
  registerCommand("panel.sortUnsorted", () => setSort("unsorted"));
  registerCommand("panel.historyBack", () => void A().historyBack());
  registerCommand("panel.historyForward", () => void A().historyForward());
  registerCommand("panel.newTab", () => A().newTab());
  registerCommand("panel.closeTab", () => A().closeTab());
  registerCommand("panel.copyNames", () => {
    const names = A()
      .targetEntries.map((e) => e.name)
      .join("\r\n");
    if (names) void navigator.clipboard.writeText(names);
  });
  registerCommand("panel.copyPaths", () => {
    const paths = A().targetPaths.join("\r\n");
    if (paths) void navigator.clipboard.writeText(paths);
  });
  registerCommand("panel.enterExternal", () => void A().enterExternal());
  registerCommand("panel.dirHistory", () => ui.openDialog("dirHistory"));
  registerCommand("panel.quickJump", (latin) => {
    const l = String(latin ?? "");
    if (l) A().quickJump(l);
  });

  // ---------- viewer ----------
  registerCommand("viewer.open", () => {
    const p = A();
    for (const e of p.targetEntries) {
      void editor.view(joinPath(p.path, e.name));
    }
  });
  registerCommand("viewer.toEditor", () => editor.toEditorActive());
  registerCommand("viewer.toggleHex", () => editor.toggleHexActive());
  registerCommand("viewer.close", () => void editor.closeViewer());

  // ---------- editor ----------
  registerCommand("editor.open", () => {
    const p = A();
    const first = p.targetEntries[0];
    if (first) void editor.open(joinPath(p.path, first.name));
  });
  registerCommand("editor.newFile", () => void editor.newFile(A().path));

  // ---------- file operations ----------
  registerCommand("fs.copy", () => startTransfer("copy"));
  registerCommand("fs.copyCurrent", () => startTransfer("copy", true));
  registerCommand("fs.move", () => startTransfer("move"));
  registerCommand("fs.renameCurrent", async () => {
    const p = A();
    const cur = p.current;
    if (!cur || cur.name === "..") return;
    const nn = await ui.askInput(i18n.t("rename.title"), i18n.t("rename.prompt"), cur.name);
    if (!nn || nn === cur.name) return;
    try {
      await renamePath(joinPath(p.path, cur.name), joinPath(p.path, nn));
      p.refresh();
    } catch (e) {
      ui.showError(String(e));
    }
  });
  registerCommand("fs.mkdir", async () => {
    const p = A();
    const name = await ui.askInput(i18n.t("mkdir.title"), i18n.t("mkdir.prompt"), "");
    if (!name) return;
    try {
      await mkdir(joinPath(p.path, name));
      p.refresh();
      const idx = p.view.findIndex((e) => e.name === name);
      if (idx >= 0) p.cursor = idx;
    } catch (e) {
      ui.showError(String(e));
    }
  });
  registerCommand("fs.delete", () => startDelete(false, false));
  registerCommand("fs.deleteCurrent", () => startDelete(false, true));
  registerCommand("fs.deletePermanent", () => startDelete(true, false));

  // ---------- folder shortcuts (FAR Ctrl+0..9 / Ctrl+Shift+0..9) ----------
  for (let d = 0; d <= 9; d++) {
    registerCommand(`shortcuts.jump${d}`, async () => {
      const ok = await panels.jumpShortcut(String(d));
      if (!ok) ui.showToast(i18n.t("shortcuts.jumpEmpty", { k: String(d) }));
    });
    registerCommand(`shortcuts.assign${d}`, () => {
      panels.assignShortcut(String(d));
      ui.showToast(i18n.t("shortcuts.assigned", { k: String(d) }));
    });
  }

  // ---------- ui ----------
  // Ctrl+Tab walks a FAR-style window ring: editor docs, then viewer docs, then
  // the panels, and around again (file1 -> file2 -> panels -> file1). With a
  // single document it degenerates into the editor <-> panels toggle; with
  // nothing open it keeps the old meaning of cycling file-panel tabs.
  const stepWindowRing = (dir: 1 | -1) => {
    type RingWin = { mode: "editor" | "viewer"; id: number } | { mode: "panels" };
    const ring: RingWin[] = [
      ...editor.docs.map((d) => ({ mode: "editor" as const, id: d.id })),
      ...editor.viewDocs.map((d) => ({ mode: "viewer" as const, id: d.id })),
    ];
    if (ring.length === 0) {
      A().cycleTab(dir);
      return;
    }
    ring.push({ mode: "panels" });

    let i = ring.findIndex((w) => {
      if (w.mode !== ui.mode) return false;
      if (w.mode === "panels") return true;
      return w.id === (w.mode === "editor" ? editor.activeId : editor.activeViewId);
    });
    if (i < 0) i = ring.length - 1; // unknown position: step from panels

    const next = ring[(i + dir + ring.length) % ring.length];
    if (next.mode === "panels") ui.setMode("panels");
    else if (next.mode === "editor") {
      editor.activeId = next.id;
      ui.setMode("editor");
    } else {
      editor.activeViewId = next.id;
      ui.setMode("viewer");
    }
  };
  registerCommand("ui.nextTab", () => stepWindowRing(1));
  registerCommand("ui.prevTab", () => stepWindowRing(-1));
  registerCommand("ui.windowList", () => ui.openDialog("windowList"));
  registerCommand("ui.menu", () => ui.openDialog("menu"));
  registerCommand("ui.help", () => ui.openDialog("help"));
  registerCommand("app.quit", async () => {
    if (await ui.askConfirm(i18n.t("menu.quitConfirm"))) {
      panels.saveSession();
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      void getCurrentWindow().close();
    }
  });
  registerCommand("dialog.close", () => {
    if (ui.confirmReq) ui.confirmReq.resolve(false);
    else if (ui.inputReq) ui.inputReq.resolve(null);
    else if (ops.conflict) ops.resolveConflictAction("skip");
    else ui.closeDialog();
  });

  // ---------- cmdline ----------
  registerCommand("cmdline.history", () => ui.openDialog("cmdHistory"));
  registerCommand("cmdline.prevHistory", () => {
    cmdline.stepHistory(-1);
  });
  registerCommand("cmdline.pasteClipboard", async () => {
    try {
      const text = await navigator.clipboard.readText();
      cmdline.setText(text.split(/\r?\n/)[0] ?? "");
      cmdline.focusInput();
    } catch {
      /* clipboard unavailable */
    }
  });

  // ---------- editor specifics ----------
  registerCommand("editor.save", () => void editor.save());
  registerCommand("editor.saveAs", () => void editor.saveAs());
  registerCommand("editor.close", () => void editor.close());
  registerCommand("editor.search", async () => {
    const { openSearchPanelCmd } = await import("$lib/editor/cm");
    openSearchPanelCmd();
  });
  registerCommand("editor.deleteLine", async () => {
    const { deleteLineCmd } = await import("$lib/editor/cm");
    deleteLineCmd();
  });
  registerCommand("editor.gotoLine", async () => {
    const lineStr = await ui.askInput(i18n.t("editor.gotoLine"), i18n.t("editor.lineNo"), "1");
    if (!lineStr) return;
    const line = parseInt(lineStr, 10);
    if (Number.isFinite(line)) {
      const { gotoLineCmd } = await import("$lib/editor/cm");
      gotoLineCmd(line);
    }
  });

  // ---------- stubs for future milestones ----------
  const stub = (featureKey: string) => () =>
    ui.showToast(i18n.t("misc.comingSoon", { feature: i18n.t(featureKey) }));
  registerCommand("stub.search", stub("misc.feature.search"));
  registerCommand("stub.pack", stub("misc.feature.pack"));
  registerCommand("stub.unpack", stub("misc.feature.unpack"));
  registerCommand("stub.attrs", stub("misc.feature.attrs"));
  registerCommand("stub.userMenu", stub("misc.feature.userMenu"));
  registerCommand("stub.viewHistory", stub("misc.feature.viewHistory"));

  // expose a couple of helpers used by dialogs
  registerCommand("dev.home", () => void homePath());
}

function setSort(mode: "name" | "ext" | "mtime" | "size" | "unsorted") {
  const p = panels.active;
  // same mode again = reverse (unsorted has no direction)
  if (p.sortMode === mode && mode !== "unsorted") {
    p.sortDir = p.sortDir === 1 ? -1 : 1;
  } else {
    p.sortMode = mode;
    p.sortDir = 1;
  }
  p.rebuild();
  const label =
    mode === "unsorted" ? "Unsorted" : mode === "name" ? "Name" : mode === "ext" ? "Ext" : mode === "mtime" ? "Mtime" : "Size";
  const arrow = mode === "unsorted" ? "" : " " + sortArrow(mode, p.sortDir);
  ui.showToast(i18n.t(`panel.sort${label}`) + arrow);
}

async function startTransfer(kind: "copy" | "move", currentOnly = false) {
  const p = panels.active;
  const entries = currentOnly
    ? p.current && p.current.name !== ".."
      ? [p.current]
      : []
    : p.targetEntries;
  if (!entries.length) return;
  const paths = entries.map((e) => joinPath(p.path, e.name));
  const dest = panels.inactive.path;
  const title = kind === "copy" ? i18n.t("ops.copyTo", { n: entries.length }) : i18n.t("ops.moveTo", { n: entries.length });
  const answer = await ui.askInput(title, i18n.t("ops.dst"), dest);
  if (!answer) return;
  if (kind === "copy") void ops.startCopy(paths, answer);
  else void ops.startMove(paths, answer);
}

async function startDelete(permanent: boolean, currentOnly = false) {
  const p = panels.active;
  const entries = currentOnly
    ? p.current && p.current.name !== ".."
      ? [p.current]
      : []
    : p.targetEntries;
  if (!entries.length) return;
  const paths = entries.map((e) => joinPath(p.path, e.name));
  const msg = `${permanent ? i18n.t("ops.deletePermanent") : i18n.t("ops.toTrash")}: ${i18n.t("ops.deleteConfirm", { n: entries.length })}`;
  if (settings.s.confirmDelete && !(await ui.askConfirm(msg))) return;
  void ops.startDelete(paths, permanent);
}
