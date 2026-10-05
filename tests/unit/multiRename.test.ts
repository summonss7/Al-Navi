import { describe, expect, it } from "vitest";
import { applyMultiRename, defaultMrForm, type MrTarget } from "$lib/multiRename";

const T = (name: string, path = `C:\\d\\${name}`): MrTarget => ({ path, name });
/** apply with a partial form over the defaults */
function run(targets: MrTarget[], patch: Partial<ReturnType<typeof defaultMrForm>> = []) {
  const f = { ...defaultMrForm(), ...patch };
  return applyMultiRename(targets, f);
}

describe("defaultMrForm", () => {
  it("starts as the identity rename", () => {
    const f = defaultMrForm();
    expect(f.mask).toBe("*");
    expect(f.nameTmpl).toBe("[N]");
    expect(f.extTmpl).toBe("[E]");
    expect(f.countStart).toBe(1);
  });
});

describe("applyMultiRename", () => {
  it("default form keeps every name -> status unchanged", () => {
    const rows = run([T("a.txt"), T("b.rar")]);
    expect(rows.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
    expect(rows[0].newName).toBe("a.txt");
  });

  it("mask narrows the target set", () => {
    const rows = run([T("a.txt"), T("b.rar")], { mask: "*.txt" });
    expect(rows).toHaveLength(1);
    expect(rows[0].oldName).toBe("a.txt");
  });

  it("[N]/[E] split at the last dot, dotfiles have no extension", () => {
    const rows = run([T("a.tar.gz"), T("README")], { nameTmpl: "[N]_copy", extTmpl: "[E]" });
    expect(rows[0].newName).toBe("a.tar_copy.gz");
    // no ext -> the ext part stays empty and no dot is appended
    expect(rows[1].newName).toBe("README_copy");
  });

  it("[C] counts from countStart by countStep, zero-padded to countDigits", () => {
    const rows = run([T("a.txt"), T("b.txt"), T("c.txt")], {
      nameTmpl: "file[C]",
      extTmpl: "txt",
      countStart: 5,
      countStep: 2,
      countDigits: 3,
    });
    expect(rows.map((r) => r.newName)).toEqual(["file005.txt", "file007.txt", "file009.txt"]);
  });
  it("countStep 0 is treated as 1 instead of freezing the counter", () => {
    const rows = run([T("a.txt"), T("b.txt")], { nameTmpl: "n[C]", extTmpl: "txt", countStep: 0 });
    expect(rows.map((r) => r.newName)).toEqual(["n1.txt", "n2.txt"]);
  });

  it("find/replace is literal (regex chars escaped) and case-insensitive by default", () => {
    const rows = run([T("old.file.txt")], { find: "old.file", replace: "new" });
    expect(rows[0].newName).toBe("new.txt");
    const noDot = run([T("oldXfile.txt")], { find: "old.file", replace: "new" });
    expect(noDot[0].status).toBe("unchanged");
    // case-insensitive: the mask "A" still finds every lowercase "a"
    const ci = run([T("banana.txt")], { find: "A", replace: "X" });
    expect(ci[0].newName).toBe("bXnXnX.txt");
    const cs = run([T("banana.txt")], { find: "A", replace: "X", caseSensitive: true });
    expect(cs[0].status).toBe("unchanged");
  });

  it("invalid Windows names are flagged, not produced", () => {
    const colon = run([T("a.txt")], { find: "a", replace: "a:b" });
    expect(colon[0].status).toBe("invalid");
    const trailingDot = run([T("a.txt")], { nameTmpl: "x.", extTmpl: "" });
    expect(trailingDot[0].newName).toBe("x.");
    expect(trailingDot[0].status).toBe("invalid");
    const trailingSpace = run([T("a.txt")], { nameTmpl: "x ", extTmpl: "" });
    expect(trailingSpace[0].status).toBe("invalid");
  });

  it("two targets mapping to one name -> the second is dup", () => {
    const rows = run([T("a.txt"), T("b.txt")], { nameTmpl: "same", extTmpl: "txt" });
    expect(rows.map((r) => r.status)).toEqual(["ok", "dup"]);
    expect(rows[0].newName).toBe("same.txt");
  });

  it("rows carry the old path for the rename call", () => {
    const rows = run([T("a.txt", "C:\\src\\a.txt")], { nameTmpl: "x", extTmpl: "txt" });
    expect(rows[0].oldPath).toBe("C:\\src\\a.txt");
    expect(rows[0].oldName).toBe("a.txt");
  });
});
