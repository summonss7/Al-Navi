import { EditorView, keymap, highlightActiveLine, lineNumbers, drawSelection, highlightSpecialChars, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { EditorState, EditorSelection, Compartment, RangeSetBuilder } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  deleteLine as cmDeleteLine,
  cursorDocStart,
  cursorDocEnd,
  cursorLineUp,
  cursorLineDown,
  cursorCharLeft,
  cursorCharRight,
  cursorLineStart,
  cursorLineEnd,
  cursorPageUp,
  cursorPageDown,
} from "@codemirror/commands";
import {
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  SearchQuery,
} from "@codemirror/search";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, type LanguageSupport } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { extOf } from "$lib/format";
import { settings } from "$lib/stores/settings.svelte";
import { textColors } from "$lib/stores/textColors.svelte";
import { transformCase, convertLayout, type CaseMode, type LayoutMode } from "$lib/plugins";

/* ============ language packs (lazy, alnavi-013) ============
 * Every grammar is a dynamic import: together they outweighed the whole app
 * (~800 KB of the former 1.3 MB single chunk), yet most are opened rarely.
 * Each loader becomes its own small chunk fetched from the app's own assets
 * (same origin, CSP 'self') on first open — a local read of a few ms; once
 * loaded the LanguageSupport is cached and re-applied synchronously, so
 * switching files of a known language never re-parses asynchronously. */
const LANG_LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  c: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  php: () => import("@codemirror/lang-php").then((m) => m.php()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
};

/** resolved grammars: a hit is applied in the same dispatch as the doc swap */
const langCache = new Map<string, LanguageSupport>();
/** in-flight loads, so parallel opens of the same language fetch one chunk */
const langPromises = new Map<string, Promise<LanguageSupport>>();

function loadLanguage(key: string): Promise<LanguageSupport> {
  let p = langPromises.get(key);
  if (!p) {
    p = LANG_LOADERS[key]().then((lang) => {
      langCache.set(key, lang);
      return lang;
    });
    langPromises.set(key, p);
    // a failed fetch must not poison the key — next open retries
    p.catch(() => langPromises.delete(key));
  }
  return p;
}

/** the language each live view currently wants: a load resolving after the
 *  view moved to another document must not override the newer language */
const viewLangKeys = new WeakMap<EditorView, string>();

/** Wire the document's language into the view's compartment, pulling its
 *  chunk on first use. The compartment starts empty — the caller resets it
 *  when swapping documents, this only installs what arrives. */
function applyLang(v: EditorView, path: string | null, content = ""): void {
  const key = langKeyFor(path, content);
  viewLangKeys.set(v, key ?? "");
  if (!key) return;
  const cached = langCache.get(key);
  if (cached) {
    v.dispatch({ effects: langComp.reconfigure([cached]) });
    return;
  }
  loadLanguage(key)
    .then((lang) => {
      if (viewLangKeys.get(v) === key) v.dispatch({ effects: langComp.reconfigure([lang]) });
    })
    .catch((err) => console.error(`alnavi: language chunk "${key}" failed to load`, err));
}

let view: EditorView | null = null;
const langComp = new Compartment();
const wrapComp = new Compartment();
const readOnlyComp = new Compartment();
const decorComp = new Compartment();

/* ============ text highlighting (F4/F3, any file incl. .txt) ============
 * A ViewPlugin painting Decoration marks over the visible ranges — no parser
 * needed, so plain-text notes/logs get the same treatment as code. Rules and
 * colors come from the textColors store (F9 -> text rules): user mask rules
 * run first (explicit intent beats built-ins), then dates, then 2+ symbol
 * runs. Each mark carries its color in a --tx custom property so solid-cursor
 * themes can darken it on the inverted active line without losing the hue
 * (see the color-mix rule in app.css). */

// ISO / dotted / slashed dates with an optional HH:MM(:SS) tail, then bare times
const DATE_RES: RegExp[] = [
  /\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /\d{1,2}\.\d{1,2}\.\d{4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /\d{1,2}\/\d{1,2}\/\d{4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?/g,
];
// 2+ consecutive non-letter/non-digit/non-space chars: == -- ### >>> …
const SPEC_RE = /[^\p{L}\p{N}\s]{2,}/gu;

function txMark(color: string | null, themeVar: string, bold: boolean): Decoration {
  const c = color ?? `var(${themeVar})`;
  return Decoration.mark({
    class: "cm-tx",
    attributes: { style: `--tx:${c};color:var(--tx);font-weight:${bold ? 700 : 400}` },
  });
}

function buildDecors(v: EditorView): DecorationSet {
  const taken: Array<[number, number]> = [];
  const marks: Array<{ from: number; to: number; deco: Decoration }> = [];
  const scan = (re: RegExp, deco: Decoration, from: number, text: string) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!m[0]) {
        re.lastIndex++; // empty match (e.g. a bare * mask) would loop forever
        continue;
      }
      const s = from + m.index;
      const e = s + m[0].length;
      if (taken.some(([ts, te]) => s < te && e > ts)) continue; // earlier match wins
      marks.push({ from: s, to: e, deco });
      taken.push([s, e]);
    }
  };
  const { dates, special } = textColors.s;
  const userMarks = textColors.matchers.map((u) => ({
    re: u.re,
    deco: txMark(u.color, "--cm-special", u.bold),
  }));
  const dateMark = txMark(dates.color, "--cm-date", dates.bold);
  const specMark = txMark(special.color, "--cm-special", special.bold);
  for (const { from, to } of v.visibleRanges) {
    const text = v.state.sliceDoc(from, to);
    for (const u of userMarks) scan(u.re, u.deco, from, text);
    // DATE_RES order matters: full dates claim their HH:MM tail before the bare
    // time pattern gets a chance to overlap it
    if (dates.on) for (const re of DATE_RES) scan(re, dateMark, from, text);
    if (special.on) scan(SPEC_RE, specMark, from, text);
  }
  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const m of marks) b.add(m.from, m.to, m.deco);
  return b.finish();
}

/** factory: applyEditorDecor() reconfigures the compartment with a FRESH
 *  plugin instance, so every rule/color edit rebuilds the decorations */
const makeDecorPlugin = () =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) {
        this.decorations = buildDecors(v);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = buildDecors(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

/** Al-Navi syntax colors driven by theme CSS variables.
 *  Every role gets its own hue per theme (--cm-*); definition names share the
 *  name color but are bold, invalid gets an underline — no two roles look
 *  alike within a theme. */
const alnaviHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--cm-keyword)", fontWeight: "700" },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "var(--cm-name)" },
  { tag: [t.function(t.variableName), t.labelName, t.tagName], color: "var(--cm-func)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name), t.attributeName], color: "var(--cm-const)" },
  { tag: [t.definition(t.name)], color: "var(--cm-def)", fontWeight: "700" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: "var(--cm-type)" },
  { tag: [t.operator, t.url, t.escape, t.regexp, t.special(t.string), t.separator, t.bracket, t.punctuation], color: "var(--cm-op)" },
  { tag: [t.meta, t.comment, t.processingInstruction, t.contentSeparator], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--cm-op)", textDecoration: "underline" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "bold", color: "var(--cm-type)" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--cm-const)" },
  { tag: [t.string, t.inserted], color: "var(--cm-string)" },
  { tag: t.invalid, color: "var(--cm-invalid)", textDecoration: "underline" },
  { tag: t.variableName, color: "var(--cm-name)" },
]);

/** Map a file path (or content, for pathless docs) to a LANG_LOADERS key.
 *  Extensions without a grammar — plain text, sh, … — yield null and the
 *  editor stays on the built-in text decorations. */
export function langKeyFor(path: string | null, content = ""): string | null {
  const ext = path ? extOf(path) : guessExtFromContent(content);
  switch (ext) {
    case "js": case "mjs": case "cjs":
      return "js";
    case "jsx":
      return "jsx";
    case "ts": case "mts": case "cts":
      return "ts";
    case "tsx":
      return "tsx";
    case "py": case "pyw":
      return "py";
    case "rs":
      return "rs";
    case "c": case "h": case "cpp": case "hpp": case "cc": case "hh": case "cxx":
      return "c";
    case "json": case "jsonc":
      return "json";
    case "yaml": case "yml":
      return "yaml";
    case "html": case "htm":
      return "html";
    case "css": case "scss": case "less":
      return "css";
    case "md": case "markdown":
      return "md";
    case "sql":
      return "sql";
    case "go":
      return "go";
    case "java":
      return "java";
    case "php":
      return "php";
    case "xml": case "svg": case "xsl": case "plist":
      return "xml";
    default:
      return null;
  }
}

function guessExtFromContent(content: string): string {
  const head = content.slice(0, 512);
  if (/^\s*[{[]/.test(head)) return "json";
  if (/^#!.*\b(python|python3)\b/.test(head)) return "py";
  if (/^#!.*\b(bash|sh|zsh)\b/.test(head)) return "sh";
  return "txt";
}

export function createView(
  host: HTMLElement,
  text: string,
  path: string | null,
  opts: { readOnly?: boolean; onChange?: (text: string) => void } = {},
): EditorView {
  const st = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      // column selection (alnavi-034) and multi-cursor need this: without
      // the facet every selection update is reduced to its main range
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      syntaxHighlighting(alnaviHighlight),
      decorComp.of(settings.s.editorDecor ? makeDecorPlugin() : []),
      langComp.of([]), // the grammar lands via applyLang when its chunk arrives
      wrapComp.of(settings.s.editorWordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.of(opts.readOnly ? EditorState.readOnly.of(true) : []),
      keymap.of([
        // FAR: Ctrl+PageUp/PageDown place the caret at the very start / very
        // end of the text (works in the editor and the read-only viewer)
        { key: "Ctrl-PageUp", run: cursorDocStart },
        { key: "Ctrl-PageDown", run: cursorDocEnd },
        // FAR-style column (vertical block) selection, alnavi-034: must sit
        // before defaultKeymap, whose Alt+ArrowLeft/Right carry shift
        // variants (word-group select) that these chords replace
        { key: "Shift-Alt-ArrowUp", run: (v) => columnSelectCmd(v, "up") },
        { key: "Shift-Alt-ArrowDown", run: (v) => columnSelectCmd(v, "down") },
        { key: "Shift-Alt-ArrowLeft", run: (v) => columnSelectCmd(v, "left") },
        { key: "Shift-Alt-ArrowRight", run: (v) => columnSelectCmd(v, "right") },
        { key: "Shift-Alt-PageUp", run: (v) => columnSelectCmd(v, "pageUp") },
        { key: "Shift-Alt-PageDown", run: (v) => columnSelectCmd(v, "pageDown") },
        { key: "Shift-Alt-Home", run: (v) => columnSelectCmd(v, "lineStart") },
        { key: "Shift-Alt-End", run: (v) => columnSelectCmd(v, "lineEnd") },
        // a plain caret move collapses the block back to its main caret (FAR:
        // the block is a selection, not a persistent multi-cursor) and then
        // moves as usual; with a single cursor these fall through untouched
        { key: "ArrowUp", run: (v) => collapseColumn(v, cursorLineUp) },
        { key: "ArrowDown", run: (v) => collapseColumn(v, cursorLineDown) },
        { key: "ArrowLeft", run: (v) => collapseColumn(v, cursorCharLeft) },
        { key: "ArrowRight", run: (v) => collapseColumn(v, cursorCharRight) },
        { key: "Home", run: (v) => collapseColumn(v, cursorLineStart) },
        { key: "End", run: (v) => collapseColumn(v, cursorLineEnd) },
        { key: "PageUp", run: (v) => collapseColumn(v, cursorPageUp) },
        { key: "PageDown", run: (v) => collapseColumn(v, cursorPageDown) },
        // block delete: a row too short for the column (empty range) must
        // delete nothing — CodeMirror's own delete would eat the newline at
        // a line end and merge the rows
        { key: "Delete", run: (v) => columnDelete(v, "delete.forward") },
        { key: "Backspace", run: (v) => columnDelete(v, "delete.backward") },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          columnRect = null; // an edit ends column mode (typing replaced the block)
          opts.onChange?.(u.state.doc.toString());
        }
      }),
      // extension handlers run before CodeMirror's built-in clipboard ones,
      // so a live block copies/cuts with its empty rows in place (the block
      // stays aligned when pasted); cut in the read-only viewer just copies
      EditorView.domEventHandlers({
        copy(event, v) {
          const c = columnClipboard(v);
          if (!c || !event.clipboardData) return false;
          event.preventDefault();
          event.clipboardData.setData("text/plain", c.text);
          return true;
        },
        cut(event, v) {
          const c = columnClipboard(v);
          if (!c || !event.clipboardData) return false;
          event.preventDefault();
          event.clipboardData.setData("text/plain", c.text);
          const live = c.ranges.filter((r) => r.from !== r.to);
          if (!v.state.readOnly && live.length) v.dispatch({ changes: live, userEvent: "delete.cut", scrollIntoView: true });
          return true;
        },
      }),
      EditorView.theme({
        "&": { height: "100%", fontSize: "calc(13.5px * var(--fs-scale))" },
        ".cm-scroller": {
          fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
          lineHeight: "1.55",
        },
        ".cm-content": { caretColor: "var(--accent2)" },
        "&.cm-focused": { outline: "none" },
        ".cm-gutters": {
          // opaque like the editor card: the gutter is sticky and floats ABOVE
          // the horizontally scrolled text (z-index 200); with a transparent
          // background the line beginnings slid under the numbers and mixed
          // with them after a search jump/wrap (alnavi-035)
          backgroundColor: "var(--bg-panel)",
          color: "var(--fg-dim)",
          border: "none",
          borderInlineEnd: "1px solid var(--border)",
        },
        // cursor line mirrors the panel cursor row (orange frame on light themes,
        // full inversion on solid themes via [data-cursor="solid"] rules in app.css)
        ".cm-activeLine": { backgroundColor: "var(--row-cursor-bg)" },
        ".cm-activeLineGutter": { backgroundColor: "var(--row-cursor-bg)", color: "var(--row-cursor-fg)" },
        ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent2) 25%, transparent)" },
        // selection background is themed globally in app.css (must beat CM's
        // base-theme specificity and paint above the active-line fill)
        "::selection": { backgroundColor: "color-mix(in srgb, var(--accent2) 30%, transparent)" },
        ".cm-panels": {
          backgroundColor: "var(--bg-elev)",
          color: "var(--fg)",
          border: "none",
          borderTop: "1px solid var(--border)",
        },
        ".cm-panel input, .cm-panel button": {
          background: "var(--bg)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          padding: "2px 6px",
          margin: "2px 4px",
        },
        ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent2) 35%, transparent)" },
        ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)" },
      }),
    ],
  });
  view = new EditorView({ state: st, parent: host });
  applyLang(view, path, text);
  return view;
}

export function setActiveView(v: EditorView | null) {
  view = v;
}

export function openSearchPanelCmd() {
  if (view) openSearchPanel(view);
}

export { SearchQuery };

export function deleteLineCmd() {
  if (view) cmDeleteLine(view);
}

/* ============ column (rectangular) selection, alnavi-034 ============
 * FAR-style vertical blocks from the keyboard: Shift+Alt+arrows paint one
 * selection range per line over the rectangle's line/column span — a plain
 * CodeMirror multi-selection, so everything works on it for free: copy
 * joins the rows with newlines (FAR block-copy semantics), cut/Delete
 * remove them, typing replaces every row, the F11 plugins act per row.
 * The intended rectangle lives in columnRect; a keystroke only continues
 * it while the live selection still paints exactly that rectangle — any
 * click, plain-arrow move or edit means the user is elsewhere, and the
 * block restarts from the caret. */
interface ColumnRect {
  anchorLine: number;
  anchorCol: number;
  headLine: number;
  headCol: number;
}
let columnRect: ColumnRect | null = null;

/** selection ranges of the rectangle: one per spanned line, clamped into
 *  each line (a shorter line contributes its tail, as in FAR) */
function columnRanges(v: EditorView, r: ColumnRect): { from: number; to: number }[] {
  const doc = v.state.doc;
  const l1 = Math.max(1, Math.min(r.anchorLine, r.headLine));
  const l2 = Math.min(doc.lines, Math.max(r.anchorLine, r.headLine));
  const c1 = Math.max(0, Math.min(r.anchorCol, r.headCol));
  const c2 = Math.max(0, Math.max(r.anchorCol, r.headCol));
  const ranges: { from: number; to: number }[] = [];
  for (let n = l1; n <= l2; n++) {
    const line = doc.line(n);
    ranges.push({ from: Math.min(line.from + c1, line.to), to: Math.min(line.from + c2, line.to) });
  }
  return ranges;
}

/** does the live selection still paint exactly this rectangle? */
function selectionIsColumn(v: EditorView, r: ColumnRect): boolean {
  const want = columnRanges(v, r);
  const got = v.state.selection.ranges;
  if (got.length !== want.length) return false;
  return want.every((w, i) => got[i].from === w.from && got[i].to === w.to);
}

export type ColumnDir = "up" | "down" | "pageUp" | "pageDown" | "left" | "right" | "lineStart" | "lineEnd";

/** Shift+Alt+arrows: extend (or start) the rectangular block. */
export function columnSelectCmd(v: EditorView, dir: ColumnDir): boolean {
  const doc = v.state.doc;
  if (!columnRect || !selectionIsColumn(v, columnRect)) {
    const line = doc.lineAt(v.state.selection.main.head);
    columnRect = {
      anchorLine: line.number,
      anchorCol: v.state.selection.main.head - line.from,
      headLine: line.number,
      headCol: v.state.selection.main.head - line.from,
    };
  }
  const r = columnRect;
  const headLen = doc.line(r.headLine).to - doc.line(r.headLine).from;
  switch (dir) {
    case "up":
      r.headLine = Math.max(1, r.headLine - 1);
      break;
    case "down":
      r.headLine = Math.min(doc.lines, r.headLine + 1);
      break;
    case "pageUp":
    case "pageDown": {
      const page = Math.max(1, Math.floor(v.scrollDOM.clientHeight / v.defaultLineHeight) - 1);
      r.headLine = dir === "pageUp" ? Math.max(1, r.headLine - page) : Math.min(doc.lines, r.headLine + page);
      break;
    }
    case "left":
      r.headCol = Math.max(0, r.headCol - 1);
      break;
    // the head cursor stays on its line, so widening stops at its end (the
    // block never reaches into virtual space beyond the text)
    case "right":
      r.headCol = Math.min(headLen, r.headCol + 1);
      break;
    case "lineStart":
      r.headCol = 0;
      break;
    case "lineEnd":
      r.headCol = headLen;
      break;
  }
  const l1 = Math.max(1, Math.min(r.anchorLine, r.headLine));
  const ranges = columnRanges(v, r);
  // every cursor sits on the head's edge of the block: the right one while
  // the head is at/after the anchor column, the left one after crossing over
  const after = r.headCol >= r.anchorCol;
  const sel = EditorSelection.create(
    ranges.map((x) => EditorSelection.range(after ? x.from : x.to, after ? x.to : x.from)),
    r.headLine - l1,
  );
  v.dispatch({
    selection: sel,
    effects: EditorView.scrollIntoView(sel.main.head),
  });
  return true;
}

/** plain caret moves over a live block: collapse to the main caret first
 *  (FAR semantics), then run the standard movement. Returns false with a
 *  single cursor so defaultKeymap handles the key as before. */
function collapseColumn(v: EditorView, cmd: (v: EditorView) => boolean): boolean {
  const sel = v.state.selection;
  if (sel.ranges.length < 2) return false;
  columnRect = null;
  v.dispatch({ selection: { anchor: sel.main.head } });
  return cmd(v);
}

/** block delete: only the non-empty rows participate. Returns false when
 *  there is no live block, handing the key to CodeMirror's own delete. */
function columnDelete(v: EditorView, userEvent: string): boolean {
  if (!columnRect || !selectionIsColumn(v, columnRect)) return false;
  const ranges = v.state.selection.ranges.filter((r) => !r.empty);
  if (ranges.length) v.dispatch({ changes: ranges, userEvent, scrollIntoView: true });
  return true;
}

/** clipboard form of a live block: rows joined with newlines, empty rows
 *  kept in place — CodeMirror's own serializer skips empty ranges, which
 *  would shift the shorter lines out of the block. Null (defer to the
 *  built-in linewise copy) when there is no block or it is zero-width. */
function columnClipboard(v: EditorView): { text: string; ranges: { from: number; to: number }[] } | null {
  if (!columnRect || !selectionIsColumn(v, columnRect)) return null;
  const ranges = columnRanges(v, columnRect);
  if (ranges.every((r) => r.from === r.to)) return null;
  return { text: ranges.map((r) => v.state.sliceDoc(r.from, r.to)).join("\n"), ranges };
}

/** F11 change-case plugin: transform every non-empty selection range.
 *  Returns the number of ranges changed (0 = nothing selected). */
export function changeCaseCmd(mode: CaseMode): number {
  if (!view) return 0;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const r of view.state.selection.ranges) {
    if (r.empty) continue;
    changes.push({
      from: r.from,
      to: r.to,
      insert: transformCase(view.state.sliceDoc(r.from, r.to), mode),
    });
  }
  if (changes.length) view.dispatch({ changes });
  return changes.length;
}

/** F11 layout plugin: convert every non-empty selection range between the
 *  Latin and the ЙЦУКЕН layout ("Ghbdtn" <-> "Привет"). Returns the number
 *  of ranges changed (0 = nothing selected). */
export function convertLayoutCmd(mode: LayoutMode): number {
  if (!view) return 0;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const r of view.state.selection.ranges) {
    if (r.empty) continue;
    changes.push({
      from: r.from,
      to: r.to,
      insert: convertLayout(view.state.sliceDoc(r.from, r.to), mode),
    });
  }
  if (changes.length) view.dispatch({ changes });
  return changes.length;
}

export function gotoLineCmd(line: number) {
  if (!view) return;
  const total = view.state.doc.lines;
  const l = Math.max(1, Math.min(line, total));
  const pos = view.state.doc.line(l).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}

export function setStateFor(v: EditorView, text: string, path: string | null, readOnly = false) {
  // the compartment is reset here; applyLang re-fills it from cache in the
  // same task (known language) or when the chunk lands (first open)
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: text },
    effects: [
      langComp.reconfigure([]),
      wrapComp.reconfigure(settings.s.editorWordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.reconfigure(readOnly ? EditorState.readOnly.of(true) : []),
      decorComp.reconfigure(settings.s.editorDecor ? makeDecorPlugin() : []),
    ],
  });
  applyLang(v, path, text);
}

/** remembered caret/scroll of a document (FAR-like position memory) */
export interface EditorPos {
  anchor: number;
  head: number;
  scrollTop: number;
  /** hex viewer page offset (viewer docs only) */
  hexOffset?: number;
}

export function capturePos(v: EditorView): EditorPos {
  const sel = v.state.selection.main;
  return { anchor: sel.anchor, head: sel.head, scrollTop: v.scrollDOM.scrollTop };
}

/** Apply a remembered position, clamped to the current doc. The exact scroll
 *  offset needs a measured layout, and CodeMirror measures a freshly built
 *  view later than two rAFs — hence the retry. */
export function restorePos(v: EditorView, pos: Partial<EditorPos>) {
  const len = v.state.doc.length;
  const anchor = Math.max(0, Math.min(pos.anchor ?? 0, len));
  const head = Math.max(0, Math.min(pos.head ?? anchor, len));
  if (pos.anchor !== undefined || pos.head !== undefined) {
    const restoreScroll = pos.scrollTop !== undefined && pos.scrollTop > 0;
    v.dispatch({
      selection: { anchor, head },
      // the precise offset is applied below; scrolling the cursor line into
      // view first would only fight that restore
      effects: restoreScroll ? [] : EditorView.scrollIntoView(anchor, { y: "start" }),
    });
  }
  if (pos.scrollTop !== undefined && pos.scrollTop > 0) {
    const top = pos.scrollTop;
    // The retries below fight CodeMirror's delayed re-measure of a freshly
    // mounted/swapped view — but never the user. Any caret move away from the
    // restored position (Ctrl+PageDown and every other navigation command) or
    // a wheel/scrollbar drag means the viewport is now theirs: stop asserting
    // the old offset, or the first jump after opening a file gets rolled back
    // (alnavi-030 — it "flickered" and only the second press stuck).
    const { anchor: a0, head: h0 } = v.state.selection.main;
    let mine = true;
    const abandon = () => (mine = false);
    const apply = () => {
      if (!mine) return;
      const sel = v.state.selection.main;
      if (sel.anchor !== a0 || sel.head !== h0) return;
      try {
        v.scrollDOM.scrollTop = top;
      } catch {
        /* view destroyed meanwhile */
      }
    };
    v.scrollDOM.addEventListener("wheel", abandon, { passive: true });
    v.scrollDOM.addEventListener("pointerdown", abandon, { passive: true });
    const off = () => {
      v.scrollDOM.removeEventListener("wheel", abandon);
      v.scrollDOM.removeEventListener("pointerdown", abandon);
    };
    // CodeMirror re-measures/re-resets the viewport of a freshly swapped doc
    // at various delays, so keep re-asserting the offset for a while
    requestAnimationFrame(() => requestAnimationFrame(apply));
    for (const ms of [120, 300, 600]) setTimeout(apply, ms);
    setTimeout(off, 650); // the last retry has run — stop listening
  }
}

/** Rebuild decorations on the active editor (F9 toggle or rule/color edit). */
export function applyEditorDecor() {
  view?.dispatch({
    effects: decorComp.reconfigure(settings.s.editorDecor ? makeDecorPlugin() : []),
  });
}

/** printable form of a char for the status bar: newlines/tabs get FAR-style
 *  escapes, other C0 controls use caret notation (^L), the rest show as-is */
function displayChar(code: number, raw: string): string {
  if (code === 10) return "\\n";
  if (code === 9) return "\\t";
  if (code === 13) return "\\r";
  if (code < 32) return "^" + String.fromCharCode(code + 64);
  if (code === 127) return "^?";
  return raw;
}

/** the character under the caret: the one right of it, or the last character
 *  when the caret sits at the very end. Code point (ASCII for Latin, Unicode
 *  otherwise) + a printable representation; null in an empty document. */
function charUnderCursor(v: EditorView): { ch: string; code: number } | null {
  const text = v.state.doc;
  const head = v.state.selection.main.head;
  if (text.length === 0) return null;
  if (head < text.length) {
    // sliceString (not sliceDoc) — Text keeps it O(1)-ish, no full-doc copy
    const s = text.sliceString(head, head + 2);
    const code = s.codePointAt(0)!;
    return { ch: displayChar(code, String.fromCodePoint(code)), code };
  }
  const s = text.sliceString(Math.max(0, head - 2), head);
  let i = s.length - 1;
  const cu = s.charCodeAt(i);
  // step off a lone low surrogate to keep a pair together
  if (cu >= 0xdc00 && cu <= 0xdfff && i > 0) i--;
  const code = s.codePointAt(i)!;
  return { ch: displayChar(code, String.fromCodePoint(code)), code };
}

export function lineColOf(v: EditorView): { line: number; col: number; sel: number; ch: string; code: number | null } {
  const sel = v.state.selection.main;
  const line = v.state.doc.lineAt(sel.head);
  const cu = charUnderCursor(v);
  return {
    line: line.number,
    col: sel.head - line.from + 1,
    sel: Math.abs(sel.to - sel.from),
    ch: cu?.ch ?? "",
    code: cu?.code ?? null,
  };
}

export function currentView(): EditorView | null {
  return view;
}
