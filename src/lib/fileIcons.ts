import { extOf } from "./format";

export interface IconSpec {
  icon: string; // phosphor class
  color: string; // css color
}

const C = {
  dir: "#8EE53F",
  code: "#8EE53F",
  archive: "#F97316",
  image: "#F472B6",
  audio: "#A78BFA",
  video: "#FB7185",
  doc: "#60A5FA",
  sheet: "#34D399",
  pdf: "#EF4444",
  binary: "#9E9E9E",
  text: "#9E9E9E",
  font: "#FBBF24",
  web: "#38BDF8",
};

const MAP: Record<string, IconSpec> = {
  archive: { icon: "ph-duotone ph-file-zip", color: C.archive },
  image: { icon: "ph-duotone ph-image", color: C.image },
  audio: { icon: "ph-duotone ph-music-notes", color: C.audio },
  video: { icon: "ph-duotone ph-film-strip", color: C.video },
  code: { icon: "ph-duotone ph-file-code", color: C.code },
  doc: { icon: "ph-duotone ph-file-doc", color: C.doc },
  sheet: { icon: "ph-duotone ph-file-xls", color: C.sheet },
  pdf: { icon: "ph-duotone ph-file-pdf", color: C.pdf },
  binary: { icon: "ph-duotone ph-binary", color: C.binary },
  text: { icon: "ph-duotone ph-file-text", color: C.text },
  font: { icon: "ph-duotone ph-text-aa", color: C.font },
  web: { icon: "ph-duotone ph-globe", color: C.web },
};

const GROUPS: Record<string, string[]> = {
  archive: ["7z", "zip", "rar", "tar", "gz", "bz2", "xz", "zst", "iso", "cab", "tgz", "txz", "tbz2", "lzma", "apk", "jar", "war"],
  image: ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico", "tif", "tiff", "avif", "heic", "psd", "raw"],
  audio: ["mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "wma", "opus", "mid", "midi"],
  video: ["mp4", "mkv", "avi", "mov", "webm", "wmv", "flv", "m4v", "mpg", "mpeg", "ts", "3gp"],
  code: ["js", "mjs", "cjs", "ts", "jsx", "tsx", "py", "rs", "c", "h", "cpp", "hpp", "cc", "hh", "cs", "java", "go", "rb", "php", "pl", "lua", "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "psm1", "sql", "vue", "svelte", "swift", "kt", "kts", "scala", "dart", "ex", "exs", "erl", "hs", "clj", "asm", "s", "mak", "cmake", "gradle", "r", "jl"],
  doc: ["doc", "docx", "odt", "rtf", "tex", "md", "markdown", "txt", "nfo", "epub", "mobi", "fb2"],
  sheet: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"],
  pdf: ["pdf"],
  binary: ["exe", "msi", "dll", "so", "dylib", "bin", "o", "a", "lib", "obj", "class", "pyc", "wasm", "elf", "img", "vhd", "qcow2"],
  font: ["ttf", "otf", "woff", "woff2", "eot"],
  web: ["html", "htm", "xhtml", "css", "scss", "sass", "less", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "json", "jsonc", "geojson"],
};

const EXT_TO_GROUP: Record<string, string> = {};
for (const [g, exts] of Object.entries(GROUPS)) {
  for (const e of exts) EXT_TO_GROUP[e] = g;
}

export function iconFor(name: string, isDir: boolean, isSymlink: boolean): IconSpec {
  if (isDir) {
    return { icon: "ph-duotone ph-folder", color: isSymlink ? "#F97316" : C.dir };
  }
  const group = EXT_TO_GROUP[extOf(name)] ?? "text";
  const spec = MAP[group] ?? MAP.text;
  return isSymlink ? { icon: spec.icon, color: "#F97316" } : spec;
}

export const UP_ICON: IconSpec = { icon: "ph-duotone ph-arrow-u-up-left", color: "#9E9E9E" };
