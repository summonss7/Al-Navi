/** Encodings the backend (encoding_rs) is wired for — ids are the canonical
 *  lowercase labels textio.rs returns in TextContent.encoding, so the editor
 *  status select and the F8 dialog stay in sync with what read_text reports.
 *  "cp866" is our display alias of encoding_rs' "IBM866". */
export interface EncodingDef {
  id: string;
  label: string;
}

export const ENCODINGS: EncodingDef[] = [
  { id: "utf-8", label: "UTF-8" },
  { id: "utf-16le", label: "UTF-16 LE" },
  { id: "utf-16be", label: "UTF-16 BE" },
  { id: "windows-1251", label: "Windows-1251" },
  { id: "koi8-r", label: "KOI8-R" },
  { id: "cp866", label: "CP866 (DOS)" },
  { id: "iso-8859-5", label: "ISO-8859-5" },
];

export const encodingLabel = (id: string): string =>
  ENCODINGS.find((e) => e.id === id)?.label ?? id;

/** rows of the F8 (editor) / Shift+F8 (viewer) dialog: "auto" re-runs the
 *  detection from scratch, the rest force one encoding */
export const ENCODING_MENU: string[] = ["auto", ...ENCODINGS.map((e) => e.id)];
