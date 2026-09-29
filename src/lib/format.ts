export function formatSize(bytes: number, opts?: { binary?: boolean }): string {
  if (bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  const frac = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(frac)} ${units[i]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatSize(bps)}/s`;
}

export function formatDate(ms: number, locale: string): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    year: sameYear ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  if (dir.endsWith("\\") || dir.endsWith("/")) return dir + name;
  return dir + sep + name;
}

export function parentOf(p: string): string | null {
  // Normalize windows paths like D:\ and unix roots
  const norm = p.replace(/[\\/]+$/, "");
  if (!norm) return null;
  const sep = norm.lastIndexOf("\\") >= norm.lastIndexOf("/") ? "\\" : "/";
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  if (idx < 0) return null;
  let parent = norm.slice(0, idx);
  if (parent.length === 2 && parent[1] === ":") parent += sep; // "D:" -> "D:\"
  if (!parent) return sep;
  return parent;
}

export function isRootPath(p: string): boolean {
  return parentOf(p) === null;
}

/** Direction mark for the active sort column. dir=1 is the natural order of
 *  the mode (name/ext A→Z, mtime newest first, size largest first), so for
 *  date/size dir=1 reads as descending. */
export function sortArrow(mode: string, dir: 1 | -1): string {
  const desc = mode === "mtime" || mode === "size" ? dir === 1 : dir === -1;
  return desc ? "↓" : "↑";
}
