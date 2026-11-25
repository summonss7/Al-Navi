import { describe, expect, it } from "vitest";
import { applyRenameTemplate } from "$lib/rename-template";

// FAR ConvertWildcards semantics: wildcards borrow characters from the old
// name — the canonical "keep the extension" / "keep the stem" cases first
describe("applyRenameTemplate", () => {
  it("keeps the extension: new.*", () => {
    expect(applyRenameTemplate("file.txt", "new.*")).toBe("new.txt");
  });

  it("keeps the stem: *.bak", () => {
    expect(applyRenameTemplate("file.txt", "*.bak")).toBe("file.bak");
  });

  it("renames both parts: new.bak", () => {
    expect(applyRenameTemplate("file.txt", "new.bak")).toBe("new.bak");
  });

  it("passes a template without wildcards through unchanged", () => {
    expect(applyRenameTemplate("file.txt", "plain.txt")).toBe("plain.txt");
    expect(applyRenameTemplate("file.txt", "")).toBe("");
  });

  it("a lone star keeps the whole name", () => {
    expect(applyRenameTemplate("file.txt", "*")).toBe("file.txt");
    expect(applyRenameTemplate("file.txt", "*.*")).toBe("file.txt");
  });

  it("? copies one character of the old name per position", () => {
    // f→? i→? l→? e→? then the literal dot ends the name part
    expect(applyRenameTemplate("file.txt", "????.*")).toBe("file.txt");
    // two ? keep the first two characters of the stem
    expect(applyRenameTemplate("file.txt", "??.bak")).toBe("fi.bak");
  });

  it("a star stops at the template's own extension dot", () => {
    // the star takes the stem and stops at the source's last dot
    expect(applyRenameTemplate("report.tar.gz", "*.gz")).toBe("report.tar.gz");
    // the template dot after a star with more wildcards ahead skips the
    // source to its FIRST extension dot: new.* keeps tar.gz
    expect(applyRenameTemplate("report.tar.gz", "new.*")).toBe("new.tar.gz");
  });

  it("extension-less names: * keeps everything, new.* drops the trailing dot", () => {
    expect(applyRenameTemplate("Makefile", "*.bak")).toBe("Makefile.bak");
    expect(applyRenameTemplate("Makefile", "new.*")).toBe("new");
  });

  it("literals consume old-name characters but never cross a dot", () => {
    // each literal eats one source char (FAR does the same), so IMG_ consumes
    // "phot" and the star takes the rest of the stem up to the dot
    expect(applyRenameTemplate("photo.jpg", "IMG_*.jpg")).toBe("IMG_o.jpg");
  });

  it("drops the trailing dot Windows would strip anyway", () => {
    // without wildcards the input passes through untouched (pre-existing
    // path); inside a template the trailing dot is dropped
    expect(applyRenameTemplate("file.txt", "new.*.")).toBe("new.txt");
    // the star stops at the source extension dot; the typed dot overwrites it
    expect(applyRenameTemplate("file.txt", "*.")).toBe("file");
  });

  it("applies the template only to the name component of a typed path", () => {
    expect(applyRenameTemplate("file.txt", "D:\\docs\\new.*")).toBe("D:\\docs\\new.txt");
    expect(applyRenameTemplate("file.txt", "docs/new.*")).toBe("docs/new.txt");
    // no wildcards in the name: path and name stay as typed
    expect(applyRenameTemplate("file.txt", "D:\\docs\\plain.txt")).toBe("D:\\docs\\plain.txt");
  });

  it("handles Unicode names", () => {
    expect(applyRenameTemplate("отчёт.pdf", "новое.*")).toBe("новое.pdf");
    expect(applyRenameTemplate("отчёт.pdf", "*.docx")).toBe("отчёт.docx");
  });

  it("keeps a leading-dot (hidden) name's stem via *", () => {
    // the source's own dot at position 0 is its "extension" dot
    expect(applyRenameTemplate(".gitignore", "*")).toBe(".gitignore");
  });
});
