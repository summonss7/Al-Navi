import { beforeEach, describe, expect, it, vi } from "vitest";
// node env has no window: register-commands pulls the update store, whose
// windowState module probes window at import time — define a plain one first
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window ??= {};
});
// the Tauri bridge does not exist under vitest — stub it before any $lib/api
// importer loads (invoke answers null = "nothing saved", enough for stores)
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
// full ".svelte.ts" URL on purpose: a bare ".svelte" import would resolve as
// a component and silently create a second store instance
import { cmdline } from "$lib/stores/cmdline.svelte.ts";
import { panels } from "$lib/stores/panels.svelte";
import { runCommand } from "$lib/commands";
import { registerAllCommands } from "$lib/register-commands";
import type { FileEntry } from "$lib/types";

const entry = (name: string, isDir = false): FileEntry =>
  ({ name, isDir, size: 1, mtime: 0, attrs: "", isSymlink: false, isHidden: false }) as FileEntry;
const UP = entry("..", true);

describe("Ctrl+Enter — cmdline.insertCursorName (alnavi-045)", () => {
  beforeEach(() => {
    registerAllCommands();
    const panel = panels.active;
    panel.tab.path = "D:\\Test Dir";
    panel.view = [UP, entry("alpha"), entry("zeta")];
    panel.tab.cursor = 0;
    cmdline.setText("");
    cmdline.histIndex = -1;
  });

  it("on \"..\" inserts the folder being viewed, not the first entry", () => {
    runCommand("cmdline.insertCursorName");
    expect(cmdline.text).toBe('"D:\\Test Dir"'); // quoted: the path has a space
  });

  it("on \"..\" without spaces the path goes unquoted", () => {
    panels.active.tab.path = "D:\\Projects";
    runCommand("cmdline.insertCursorName");
    expect(cmdline.text).toBe("D:\\Projects");
  });

  it("on \"..\" the cursor stays on \"..\" (no list walking)", () => {
    runCommand("cmdline.insertCursorName");
    expect(panels.active.cursor).toBe(0);
    expect(panels.active.current?.name).toBe("..");
  });

  it("appends to existing text with a separating space", () => {
    cmdline.setText("cd");
    runCommand("cmdline.insertCursorName");
    expect(cmdline.text).toBe('cd "D:\\Test Dir"');
  });

  it("regular entries still append name by name (FAR regression)", () => {
    panels.active.tab.cursor = 1;
    runCommand("cmdline.insertCursorName");
    expect(cmdline.text).toBe("alpha");
    runCommand("cmdline.insertCursorName");
    expect(cmdline.text).toBe("alpha zeta");
    expect(panels.active.cursor).toBe(2);
  });
});
