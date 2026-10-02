import { maskToRegExp } from "$lib/format";

/** one file eligible for Ctrl+M: its real path plus the bare name shown in
 *  the preview (search rows display a path, the rename happens in the
 *  file's own directory — hence two fields) */
export interface MrTarget {
  path: string;
  name: string;
}

export interface MrForm {
  /** FAR wildcard mask narrowing the target set */
  mask: string;
  /** literal find/replace applied to the combined new name */
  find: string;
  replace: string;
  caseSensitive: boolean;
  /** name part template: [N] stem, [E] extension, [C] counter */
  nameTmpl: string;
  /** extension part template (same placeholders) */
  extTmpl: string;
  countStart: number;
  countStep: number;
  /** counter width, zero-padded */
  countDigits: number;
}

export type MrStatus = "ok" | "unchanged" | "invalid" | "dup";

export interface MrRow {
  oldPath: string;
  oldName: string;
  newName: string;
  status: MrStatus;
}

const INVALID_CHARS = /[\\/:*?"<>|]/;

export function defaultMrForm(): MrForm {
  return {
    mask: "*",
    find: "",
    replace: "",
    caseSensitive: false,
    nameTmpl: "[N]",
    extTmpl: "[E]",
    countStart: 1,
    countStep: 1,
    countDigits: 1,
  };
}

function validName(n: string): boolean {
  return (
    !!n &&
    n !== "." &&
    n !== ".." &&
    !INVALID_CHARS.test(n) &&
    !/[. ]$/.test(n) && // Windows drops trailing dots/spaces
    n.length <= 255
  );
}

/** compute the full rename preview for the current form state. Pure: the
 *  dialog calls it in a $derived, tests import it directly. */
export function applyMultiRename(targets: MrTarget[], f: MrForm): MrRow[] {
  const mask = maskToRegExp(f.mask || "*");
  const step = f.countStep === 0 ? 1 : f.countStep;
  const digits = Math.max(1, Math.floor(f.countDigits) || 1);
  let counter = Math.floor(f.countStart) || 0;
  const rows: MrRow[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (!mask.test(t.name)) continue;
    const dot = t.name.lastIndexOf(".");
    const stem = dot > 0 ? t.name.slice(0, dot) : t.name;
    const ext = dot > 0 ? t.name.slice(dot + 1) : "";
    const count = String(counter).padStart(digits, "0");
    counter += step;
    const fill = (tmpl: string): string =>
      tmpl.replace(/\[N\]|\[E\]|\[C\]/g, (m) => (m === "[N]" ? stem : m === "[E]" ? ext : count));
    let name = fill(f.nameTmpl ?? "");
    const extPart = fill(f.extTmpl ?? "");
    if (extPart) name += "." + extPart;
    if (f.find) {
      const re = new RegExp(
        f.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        f.caseSensitive ? "g" : "gi",
      );
      name = name.replace(re, f.replace);
    }
    const status: MrStatus =
      name === t.name
        ? "unchanged"
        : !validName(name)
          ? "invalid"
          : seen.has(name.toLowerCase())
            ? "dup"
            : "ok";
    if (status === "ok") seen.add(name.toLowerCase());
    rows.push({ oldPath: t.path, oldName: t.name, newName: name, status });
  }
  return rows;
}
