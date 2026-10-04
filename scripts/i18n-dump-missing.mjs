import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("src/lib/i18n/dictionaries.ts", "utf8");
function block(id) {
  const re = new RegExp(`const ${id}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`);
  return src.match(re)[1];
}
function vals(b) {
  const m = {};
  const re = /(?:^|\n)\s{2}"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g;
  let x;
  while ((x = re.exec(b))) m[x[1]] = x[2];
  return m;
}
const en = vals(block("en")), ru = vals(block("ru")), uk = vals(block("uk"));
const missing = Object.keys(en).filter((k) => !(k in uk));
const out = missing.map((k) => `${JSON.stringify(k)}\n  en: ${JSON.stringify(en[k])}\n  ru: ${JSON.stringify(ru[k])}`).join("\n");
writeFileSync("scripts/i18n-missing-dump.txt", out + "\n");
console.log("missing:", missing.length, "-> scripts/i18n-missing-dump.txt");
