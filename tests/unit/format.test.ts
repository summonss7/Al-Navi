import { describe, expect, it } from "vitest";
import {
  basename,
  extOf,
  formatCount,
  formatDate,
  formatSize,
  formatSpeed,
  isAbsolutePath,
  isRootPath,
  joinPath,
  maskToRegExp,
  parentOf,
  pathKey,
  sortArrow,
} from "$lib/format";

describe("formatSize", () => {
  it("bytes below 1 KB stay in B", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });
  it("kilobytes and up pick a unit and a sensible fraction width", () => {
    expect(formatSize(1024)).toBe("1.00 KB");
    expect(formatSize(1536)).toBe("1.50 KB");
    expect(formatSize(10 * 1024)).toBe("10.0 KB");
    expect(formatSize(100 * 1024)).toBe("100 KB");
    expect(formatSize(1024 * 1024)).toBe("1.00 MB");
    expect(formatSize(1024 ** 3)).toBe("1.00 GB");
    expect(formatSize(1024 ** 4)).toBe("1.00 TB");
    // the unit ladder stops at PB even for astronomical numbers
    expect(formatSize(1024 ** 7)).toMatch(/^[\d.]+ PB$/);
  });
  it("negative sizes render as ?", () => {
    expect(formatSize(-1)).toBe("?");
  });
});

describe("formatSpeed / formatDate / formatCount", () => {
  it("speed is a size with /s", () => {
    expect(formatSpeed(2048)).toBe("2.00 KB/s");
  });
  it("no date renders empty", () => {
    expect(formatDate(0, "en")).toBe("");
  });
  it("a date from another year shows the year digits", () => {
    expect(formatDate(Date.UTC(2000, 0, 2, 3, 4), "en")).toContain("2000");
  });
  it("a current-year date hides the year", () => {
    expect(formatDate(Date.now(), "en")).not.toContain(String(new Date().getFullYear()));
  });
  it("count formats by locale", () => {
    expect(formatCount(1234, "en")).toBe("1,234");
  });
});

describe("extOf / basename / joinPath", () => {
  it("extOf: last dot wins, dotfiles and trailing dots have none, lowercase", () => {
    expect(extOf("a.txt")).toBe("txt");
    expect(extOf("archive.ZIP")).toBe("zip");
    expect(extOf("a.tar.gz")).toBe("gz");
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("noext")).toBe("");
    expect(extOf("a.")).toBe("");
  });
  it("basename: last segment, trailing separators trimmed", () => {
    expect(basename("C:\\dir\\file.txt")).toBe("file.txt");
    expect(basename("C:\\dir\\")).toBe("dir");
    expect(basename("/a/b/")).toBe("b");
    expect(basename("file")).toBe("file");
  });
  it("joinPath keeps the separator style of the directory", () => {
    expect(joinPath("C:\\dir", "f")).toBe("C:\\dir\\f");
    expect(joinPath("C:\\dir\\", "f")).toBe("C:\\dir\\f");
    expect(joinPath("/usr", "x")).toBe("/usr/x");
  });
});

describe("isAbsolutePath / parentOf / isRootPath / pathKey", () => {
  it("drive roots and UNC are absolute, ftp is not (it has its own check)", () => {
    expect(isAbsolutePath("D:\\x")).toBe(true);
    expect(isAbsolutePath("D:/x/y")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("dir/file")).toBe(false);
    expect(isAbsolutePath("ftp://host/x")).toBe(false);
  });
  it("local parents walk up and stop at the root", () => {
    expect(parentOf("C:\\a\\b")).toBe("C:\\a");
    expect(parentOf("C:\\a")).toBe("C:\\");
    expect(parentOf("C:\\")).toBeNull();
    expect(parentOf("C:/")).toBeNull();
    expect(parentOf("/a/b")).toBe("/a");
    expect(parentOf("/a")).toBe("/");
    expect(parentOf("/")).toBeNull();
  });
  it("ftp paths pop a segment, the authority stays", () => {
    expect(parentOf("ftp://user@host:21/a/b")).toBe("ftp://user@host:21/a");
    expect(parentOf("ftp://user@host")).toBeNull();
  });
  it("archive urls pop the inner path and step out to the file's dir at the root", () => {
    expect(parentOf("archive://C:\\d\\a.zip/x/y")).toBe("archive://C:\\d\\a.zip/x");
    expect(parentOf("archive://C:\\d\\a.zip/x")).toBe("archive://C:\\d\\a.zip");
    expect(parentOf("archive://C:\\d\\a.zip")).toBe("C:\\d");
  });
  it("isRootPath is exactly a null parent", () => {
    expect(isRootPath("C:\\")).toBe(true);
    expect(isRootPath("D:/")).toBe(true);
    expect(isRootPath("C:\\x")).toBe(false);
  });
  it("pathKey ignores trailing separators and case (inner separator style stays)", () => {
    expect(pathKey("C:\\Dir\\\\")).toBe(pathKey("c:\\dir"));
    expect(pathKey("/srv/www/")).toBe("/srv/www");
  });
});

describe("maskToRegExp (FAR wildcard masks)", () => {
  it("bare * matches everything", () => {
    expect(maskToRegExp("*").test("anything.txt")).toBe(true);
    expect(maskToRegExp("").test("x")).toBe(true); // empty falls back to *
  });
  it("* and ? match case-insensitively", () => {
    const re = maskToRegExp("*.jpg");
    expect(re.test("photo.jpg")).toBe(true);
    expect(re.test("PHOTO.JPG")).toBe(true);
    expect(re.test("photo.jpeg")).toBe(false);
    expect(maskToRegExp("a?c").test("abc")).toBe(true);
    expect(maskToRegExp("a?c").test("ac")).toBe(false);
  });
  it("comma-separated alternatives", () => {
    const re = maskToRegExp("*.jpg, *.png, gif");
    expect(re.test("a.jpg")).toBe(true);
    expect(re.test("a.png")).toBe(true);
    expect(re.test("gif")).toBe(true);
    expect(re.test("a.gif")).toBe(false);
  });
  it("regex metacharacters in the mask are literal", () => {
    expect(maskToRegExp("a.b").test("axb")).toBe(false);
    expect(maskToRegExp("a.b").test("a.b")).toBe(true);
    expect(maskToRegExp("a+b").test("a+b")).toBe(true);
  });
});

describe("sortArrow", () => {
  it("name/ext: natural order (dir=1) reads ascending", () => {
    expect(sortArrow("name", 1)).toBe("↑");
    expect(sortArrow("name", -1)).toBe("↓");
  });
  it("date/size: natural order (dir=1) is descending", () => {
    expect(sortArrow("mtime", 1)).toBe("↓");
    expect(sortArrow("size", -1)).toBe("↑");
  });
});
