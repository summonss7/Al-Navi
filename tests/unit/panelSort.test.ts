import { describe, expect, it, afterEach, vi } from "vitest";
import { PanelState } from "$lib/stores/panels.svelte";
import { settings } from "$lib/stores/settings.svelte";
import type { FileEntry } from "$lib/types";

// capture dir_sizes backend calls: requestDirSizes must cap the auto-walked
// children (alnavi-047: WinSxS-like dirs with ~12k subfolders froze the app)
const sizeRequests: { paths: string[]; tag: string }[] = [];
vi.mock("$lib/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("$lib/api")>();
  return {
    ...orig,
    computeDirSizes: (paths: string[], tag: string) => {
      sizeRequests.push({ paths, tag });
      return Promise.resolve();
    },
  };
});

// PanelState.raw is private on purpose (fed by load()); tests inject the
// backend listing directly — rebuild()/applyDirSizes() stay fully real
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

  it("applyDirSizes re-sorts a size-sorted panel as walks deliver values", () => {
    const p = new PanelState("left", "C:\\t");
    feed(p, [entry("f.dat", 50), entry("X", 0, true), entry("Y", 0, true)]);
    p.sortMode = "size";
    p.rebuild(); // dirsFirst keeps folders on top; without sizes X/Y keep listing order
    expect(names(p)).toEqual(["..", "X", "Y", "f.dat"]);

    // one batched event: both values land with a single map swap
    p.applyDirSizes([{ path: "C:\\t\\Y", size: 999 }, { path: "C:\\t\\X", size: 5 }]);
    expect(p.dirSizeOf("Y")).toBe(999);
    expect(names(p)).toEqual(["..", "Y", "X", "f.dat"]);

    // and ignores sizes of unrelated directories
    p.applyDirSizes([{ path: "C:\\other\\Z", size: 12345 }]);
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

describe("auto dir-size walks are capped (alnavi-047)", () => {
  it("a WinSxS-like dir with 300 subfolders requests at most 200 walks, tagged by panel side", () => {
    const p = new PanelState("right", "C:\\WinSxS-like");
    feed(p, Array.from({ length: 300 }, (_, i) => entry("d" + String(i).padStart(3, "0"), 0, true)));
    sizeRequests.length = 0;
    (p as unknown as { requestDirSizes: (force: boolean) => void }).requestDirSizes(false);
    expect(sizeRequests.length).toBe(1);
    expect(sizeRequests[0].paths.length).toBe(200);
    expect(sizeRequests[0].tag).toBe("right");
  });
});
