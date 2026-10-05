import { describe, expect, it } from "vitest";
import { convertLayout, transformCase } from "$lib/plugins";

describe("transformCase", () => {
  it("lower / upper", () => {
    expect(transformCase("MiXeD", "lower")).toBe("mixed");
    expect(transformCase("MiXeD", "upper")).toBe("MIXED");
  });
  it("sentence: capitals after . ! ? …, works for Cyrillic", () => {
    expect(transformCase("hello. world! hi? yes… ok", "sentence"))
      .toBe("Hello. World! Hi? Yes… Ok");
    expect(transformCase("привет. мир", "sentence")).toBe("Привет. Мир");
  });
  it("title: every word capitalized, the rest lowered", () => {
    expect(transformCase("hello WORLD", "title")).toBe("Hello World");
    expect(transformCase("ПРИВЕТ мир", "title")).toBe("Привет Мир");
    // apostrophes/hyphens belong to the word: only its first letter goes up
    expect(transformCase("don't stop-loss", "title")).toBe("Don't Stop-loss");
  });
});

describe("convertLayout", () => {
  // layout conversion is NOT transliteration: it maps the physical keys, so
  // the Russian word «привет» types as "ghbdtn" on an EN layout
  it("toCyr: latin letters become ЙЦУКЕН, case preserved, punctuation untouched", () => {
    expect(convertLayout("ghbdtn", "toCyr")).toBe("привет");
    expect(convertLayout("Ghbdtn", "toCyr")).toBe("Привет");
    expect(convertLayout("a, b.", "toCyr")).toBe("ф, и.");
  });
  it("toLat: all 33 letters convert, including the punctuation-key seven", () => {
    expect(convertLayout("привет", "toLat")).toBe("ghbdtn");
    expect(convertLayout("Привет", "toLat")).toBe("Ghbdtn");
  });
  it("toLat is asymmetric: б came from the comma key, not from a letter key", () => {
    expect(convertLayout("бю", "toLat")).toBe(",.");
    expect(convertLayout("эй", "toLat")).toBe("'q");
  });
  it("auto picks the direction by the letter majority, a tie fixes to Cyrillic", () => {
    expect(convertLayout("ghbdtn", "auto")).toBe("привет"); // latin gibberish
    expect(convertLayout("привет", "auto")).toBe("ghbdtn"); // cyrillic majority
    expect(convertLayout("aб", "auto")).toBe("фб"); // 1:1 tie -> toCyr (a is on the Ф key)
  });
  it("text without letters survives unchanged", () => {
    expect(convertLayout("123 !@#", "auto")).toBe("123 !@#");
  });
});
