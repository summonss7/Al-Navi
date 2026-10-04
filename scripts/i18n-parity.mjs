#!/usr/bin/env node
// i18n parity check: every locale must expose exactly the same key set as `en`.
// Usage: node scripts/i18n-parity.mjs   (exit 1 on any diff)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/lib/i18n/dictionaries.ts"), "utf8");

// Pull each `const <id>: Record<string, string> = { … };` block and harvest its keys.
function localeBlock(id) {
  const re = new RegExp(`const ${id}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`);
  const m = src.match(re);
  if (!m) throw new Error(`block for ${id} not found`);
  return m[1];
}
function keysOf(block) {
  const keys = [];
  const re = /(?:^|\n)\s{2}"([^"]+)":\s*"/g;
  let m;
  while ((m = re.exec(block))) keys.push(m[1]);
  return keys;
}

const locales = ["en", "ru", "uk", "ro", "sk", "ar"];
const keysets = {};
for (const id of locales) {
  const ks = keysOf(localeBlock(id));
  keysets[id] = ks;
}

const en = new Set(keysets.en);
let bad = 0;
for (const id of locales) {
  const set = new Set(keysets[id]);
  const missing = keysets.en.filter((k) => !set.has(k));
  const extra = keysets[id].filter(
    (k) => !en.has(k) || keysets[id].indexOf(k) !== keysets[id].lastIndexOf(k),
  );
  const dupes = keysets[id].filter((k, i) => keysets[id].indexOf(k) !== i);
  console.log(`${id}: ${keysets[id].length} keys (en=${keysets.en.length})`);
  if (missing.length) {
    bad++;
    console.log(`  MISSING ${missing.length}:`);
    for (const k of missing) console.log(`    ${k}`);
  }
  if (extra.length) {
    bad++;
    console.log(`  EXTRA/DUP ${[...new Set([...extra, ...dupes])].length}:`);
    for (const k of new Set([...extra, ...dupes])) console.log(`    ${k}`);
  }
}
// placeholder parity: {x} tokens must survive translation 1:1 with en
function tokens(v) {
  return (v.match(/\{[a-zA-Z]\}/g) || []).sort().join(",");
}
function valuesOf(block) {
  const map = {};
  const re = /(?:^|\n)\s{2}"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(block))) map[m[1]] = m[2];
  return map;
}
const enVals = valuesOf(localeBlock("en"));
for (const id of locales.slice(1)) {
  const vals = valuesOf(localeBlock(id));
  for (const [k, v] of Object.entries(enVals)) {
    if (vals[k] !== undefined && tokens(v) !== tokens(vals[k])) {
      bad++;
      console.log(`  PLACEHOLDER MISMATCH ${id}.${k}: en={${tokens(v)}} ${id}={${tokens(vals[k])}}`);
    }
  }
}
if (bad) {
  console.log(`FAIL: ${bad} problem(s)`);
  process.exit(1);
}
console.log("OK: en/ru/uk/ro/sk/ar key sets identical, placeholders intact");
