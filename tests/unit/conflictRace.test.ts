import { beforeEach, describe, expect, it, vi } from "vitest";
// node env has no window/document: ui.openDialog -> takeKeyboard touches
// document.activeElement at call time — define plain stubs first
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window ??= {};
  (globalThis as Record<string, unknown>).document ??= { activeElement: null };
});

const invokeCalls: { cmd: string; args: unknown }[] = [];
let conflictCb: ((c: { id: number; src: string; dst: string; isDir: boolean }) => void) | null = null;
let progressCb: ((p: { id: number; phase: string }) => void) | null = null;

// the Tauri bridge does not exist under vitest — stub it before any $lib/api
// importer loads; copy_paths answers an id like the real backend
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    invokeCalls.push({ cmd, args });
    if (cmd === "copy_paths" || cmd === "move_paths") return 7;
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (ev: string, cb: (p: never) => void) => {
    if (ev === "op:conflict") conflictCb = cb as typeof conflictCb;
    if (ev === "op:progress") progressCb = cb as typeof progressCb;
    return () => {};
  },
}));

// full ".svelte.ts" URL on purpose: a bare ".svelte" import would resolve as
// a component and silently create a second store instance
import { ops } from "$lib/stores/ops.svelte.ts";
import { ui } from "$lib/stores/ui.svelte";

beforeEach(() => {
  invokeCalls.length = 0;
  ops.init();
});

describe("op:conflict vs copy_paths race (alnavi-050)", () => {
  it("a conflict event that beats the invoke response opens the dialog", async () => {
    const started = ops.startCopy(["D:\\src\\a.txt"], "D:\\dst");
    // the backend emits op:conflict before the invoke that returns the op id
    // has resolved: the store still holds the -1 placeholder
    expect(ops.op?.id).toBe(-1);
    conflictCb!({ payload: { id: 7, src: "D:\\src\\a.txt", dst: "D:\\dst\\a.txt", isDir: false } });
    // pre-fix this dropped the request and the transfer froze forever
    expect(ui.dialog).toBe("conflict");
    expect(ops.conflict?.id).toBe(7);
    // the placeholder adopts the real id, like onProgress does
    expect(ops.op?.id).toBe(7);
    await started;

    // answering must address the real op id, not the placeholder
    ops.resolveConflictAction("overwrite");
    expect(ops.conflict).toBeNull();
    expect(ui.dialog).toBe("progress"); // foreground op reopens its progress
    const last = invokeCalls[invokeCalls.length - 1];
    expect(last.cmd).toBe("resolve_conflict");
    expect(last.args).toEqual({ id: 7, action: "overwrite" });
  });

  it("move gets the same treatment: dialog opens while the id is still pending", async () => {
    const started = ops.startMove(["D:\\src\\b.txt"], "D:\\dst");
    conflictCb!({ payload: { id: 7, src: "D:\\src\\b.txt", dst: "D:\\dst\\b.txt", isDir: false } });
    expect(ui.dialog).toBe("conflict");
    await started;
    ops.resolveConflictAction("skip_all");
    expect(invokeCalls[invokeCalls.length - 1].args).toEqual({ id: 7, action: "skip_all" });
  });

  it("a conflict for another op id is still ignored once the real id is known", async () => {
    const started = ops.startCopy(["D:\\src\\c.txt"], "D:\\dst");
    await started;
    expect(ops.op?.id).toBe(7);
    conflictCb!({ payload: { id: 8, src: "x", dst: "y", isDir: false } });
    expect(ops.conflict).toBeNull();
    expect(ui.dialog).toBe("progress");
  });

  it("progress events keep flowing for an op adopted from a conflict", async () => {
    const started = ops.startCopy(["D:\\src\\d.txt"], "D:\\dst");
    conflictCb!({ payload: { id: 7, src: "D:\\src\\d.txt", dst: "D:\\dst\\d.txt", isDir: false } });
    ops.resolveConflictAction("overwrite");
    await started;
    // id was adopted from the conflict event: a progress event with the real
    // id must update the same op, not be dropped as foreign
    progressCb!({ payload: { id: 7, phase: "transfer" } });
    expect(ops.op?.phase).toBe("transfer");
  });
});
