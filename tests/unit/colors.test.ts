import { beforeAll, describe, expect, it } from "vitest";
import { COLOR_GROUPS, iconFor, UP_ICON } from "$lib/fileIcons";
// full ".svelte.ts" URLs on purpose: a bare ".svelte" import would resolve
// as a component and silently create a second store instance
import { fileColors } from "$lib/stores/fileColors.svelte.ts";
import { compileTextMask } from "$lib/stores/textColors.svelte.ts";

describe("fileIcons", () => {
  it("extensions map to their group's icon and color", () => {
    // txt lives in the doc group (blue), the gray text icon is the fallback
    expect(iconFor("a.txt", false, false).icon).toBe("ph-duotone ph-file-doc");
    expect(iconFor("main.rs", false, false).color).toBe("#8EE53F"); // code = lime
    expect(iconFor("photo.JPG", false, false).color).toBe("#F472B6"); // image, case-insensitive
    expect(iconFor("archive.zip", false, false).color).toBe("#F97316");
    expect(iconFor("unknown.zzz", false, false).icon).toBe("ph-duotone ph-file-text"); // fallback
  });
  it("directories and symlinks", () => {
    expect(iconFor("somedir", true, false).icon).toBe("ph-duotone ph-folder");
    expect(iconFor("link", true, true).color).toBe("#F97316"); // symlink dir = orange
    expect(iconFor("main.rs", false, true).color).toBe("#F97316"); // symlink file = orange
    expect(UP_ICON.icon).toBe("ph-duotone ph-arrow-u-up-left");
  });
  it("COLOR_GROUPS seed skips the gray binary/text pair", () => {
    const names = COLOR_GROUPS.map((g) => g.color);
    expect(names).not.toContain("#9E9E9E");
    // every seeded extension really resolves to its group color
    for (const g of COLOR_GROUPS) {
      for (const ext of g.exts.slice(0, 3)) {
        expect(iconFor("f." + ext, false, false).color).toBe(g.color);
      }
    }
  });
});

describe("fileColors masks", () => {
  // init() without a backend falls back to the brand defaults: the promt.txt
  // rule first, then one rule per colored icon group
  beforeAll(async () => {
    await fileColors.init();
  });

  it("brand defaults: promt.txt is red+bold ahead of the *.txt doc rule", () => {
    expect(fileColors.styleFor("promt.txt")).toEqual({ color: "#EF4444", bold: true });
    expect(fileColors.styleFor("PROMT.TXT")).toEqual({ color: "#EF4444", bold: true });
    // a bare .txt still falls through to the doc group
    expect(fileColors.styleFor("notes.txt")).toEqual({ color: "#60A5FA", bold: false });
  });
  it("group rules cover their extensions, unknown names get nothing", () => {
    expect(fileColors.styleFor("main.rs")).toEqual({ color: "#8EE53F", bold: false });
    expect(fileColors.styleFor("song.mp3")?.color).toBe("#A78BFA");
    expect(fileColors.styleFor("no-extension")).toBeNull();
    expect(fileColors.styleFor("unknown.zzz")).toBeNull();
  });
  it("wildcards * and ?, case-insensitive, several masks separated by , ; or space", () => {
    fileColors.rules = [{ id: "t1", mask: "*.log; dump??.txt, README" , color: "#111111" }];
    expect(fileColors.styleFor("app.log")?.color).toBe("#111111");
    expect(fileColors.styleFor("APP.LOG")?.color).toBe("#111111");
    expect(fileColors.styleFor("dump01.txt")?.color).toBe("#111111");
    expect(fileColors.styleFor("dump1.txt")).toBeNull(); // ? is exactly one char
    expect(fileColors.styleFor("README")?.color).toBe("#111111");
    expect(fileColors.styleFor("readme.md")).toBeNull();
  });
  it("first matching rule wins", () => {
    fileColors.rules = [
      { id: "a", mask: "*.txt", color: "#111111" },
      { id: "b", mask: "readme.txt", color: "#222222" },
    ];
    expect(fileColors.styleFor("readme.txt")?.color).toBe("#111111");
  });
  it("empty mask rules never match", () => {
    fileColors.rules = [{ id: "e", mask: "  ", color: "#111111" }];
    expect(fileColors.styleFor("anything")).toBeNull();
  });
});

describe("textColors masks (compileTextMask)", () => {
  it("unanchored + global: every occurrence of any alternative matches", () => {
    const re = compileTextMask("TODO, fixme");
    expect(re).not.toBeNull();
    expect(re!.test("xx todo yy")).toBe(true);
    expect("a FIXME b fixme".match(re!)!.length).toBe(2);
    expect(re!.test("nothing")).toBe(false);
  });
  it("wildcards stay within a line (. never crosses \\n)", () => {
    const re = compileTextMask("begin*end")!;
    expect(re.test("begin abc end")).toBe(true);
    expect(re.test("begin\nend")).toBe(false);
  });
  it("? is exactly one char, regex metacharacters are literal", () => {
    const q = compileTextMask("a?c")!;
    expect(q.test("abc")).toBe(true);
    expect(q.test("ac")).toBe(false);
    const dot = compileTextMask("a.b")!;
    expect(dot.test("axb")).toBe(false);
    expect(dot.test("a.b")).toBe(true);
  });
  it("empty or blank mask compiles to null (rule disabled)", () => {
    expect(compileTextMask("")).toBeNull();
    expect(compileTextMask("  ")).toBeNull();
  });
});
