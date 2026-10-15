import { describe, expect, it, afterEach } from "vitest";
import { PanelState } from "$lib/stores/panels.svelte";
import { settings } from "$lib/stores/settings.svelte";
import type { FileEntry } from "$lib/types";

// PanelState.raw is private on purpose (fed by load()); tests inject the
// backend listing directly — rebuild()/applyDirSize() stay fully real
function feed(p: PanelState, entries: FileEntry[]) {
  (p as unknown as { raw: FileEntry[] }).raw = entries;
}

function entry(name: string, size: number, isDir = false): FileEntry {
  return { name, isDir, size, mtime: 0, attrs: "", isSymlink: false, isHidden: false };
}

function names(p: PanelState): string[] {
  return p.view.map((e) => e.name);
}

// every case flips the global settings store — put it back for other suites
afterEach(() => {
  settings.s.dirsFirst = true;
});

describe("size sort uses computed folder sizes (Ctrl+Shift+F6)", () => {
  it("folders sort by their computed ≈ size, largest first", () => {
    const p = new PanelState("left", "C:\\t");
    feed(p, [entry("A", 0, true), entry("B", 0, true), entry("C", 0, true)]);
    p.sortMode = "size";
    p.dirSizes = new Map([
      ["C:\\t\\A", 100],
      ["C:\\t\\B", 500],
      ["C:\\t\\C", 200],
    ]);
    p.rebuild();
    expect(names(p)).toEqual(["..", "B", "C", "A"]);
  });

  it("a folder without a computed size falls back to raw 0, below known sizes", () => {
    const p = new PanelState("left", "C:\\t");
    feed(p, [entry("unknown", 0, true), entry("known", 0, true)]);
    p.sortMode = "size";
    p.dirSizes = new Map([["C:\\t\\known", 7]]);
    p.rebuild();
    expect(names(p)).toEqual(["..", "known", "unknown"]);
  });

  it("folders and files interleave by size when dirs-first is off", () => {
    settings.s.dirsFirst = false;
    const p = new PanelState("left", "C:\\t");
    feed(p, [entry("big.dat", 900), entry("dir", 0, true), entry("mid.dat", 300), entry("small.dat", 10)]);
    p.sortMode = "size";
    p.dirSizes = new Map([["C:\\t\\dir", 500]]);
    p.rebuild();
    expect(names(p)).toEqual(["..", "big.dat", "dir", "mid.dat", "small.dat"]);
  });

  it("reversed order: smallest (incl. unsized folders) first", () => {
    settings.s.dirsFirst = false;
    const p = new PanelState("left", "C:\\t");
    feed(p, [entry("a", 30), entry("d", 0, true), entry("b", 10)]);
    p.sortMode = "size";
    p.sortDir = -1;
    p.dirSizes = new Map([["C:\\t\\d", 20]]);
    p.rebuild();
    expect(names(p)).toEqual(["..", "b", "d", "a"]);
  });

  it("applyDirSize re-sorts a size-sorted panel as a walk delivers a value", () => {
    const p = new PanelState("left", "C:\\t");
    feed(p, [entry("f.dat", 50), entry("X", 0, true), entry("Y", 0, true)]);
    p.sortMode = "size";
    p.rebuild(); // dirsFirst keeps folders on top; without sizes X/Y keep listing order
    expect(names(p)).toEqual(["..", "X", "Y", "f.dat"]);

    p.applyDirSize("C:\\t\\Y", 999);
    expect(p.dirSizeOf("Y")).toBe(999);
    expect(names(p)).toEqual(["..", "Y", "X", "f.dat"]);

    // and ignores sizes of unrelated directories
    p.applyDirSize("C:\\other\\Z", 12345);
    expect(names(p)).toEqual(["..", "Y", "X", "f.dat"]);
  });

  it("other sort modes are untouched: name sort ignores folder sizes", () => {
    const p = new PanelState("left", "C:\\t");
    feed(p, [entry("z", 0, true), entry("a", 0, true)]);
    p.sortMode = "name";
    p.dirSizes = new Map([
      ["C:\\t\\z", 1],
      ["C:\\t\\a", 999],
    ]);
    p.rebuild();
    expect(names(p)).toEqual(["..", "a", "z"]);
  });
});
