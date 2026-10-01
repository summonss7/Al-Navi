import { EditorView, keymap, highlightActiveLine, lineNumbers, drawSelection, highlightSpecialChars, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { EditorState, Compartment, RangeSetBuilder } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  deleteLine as cmDeleteLine,
  cursorDocStart,
  cursorDocEnd,
} from "@codemirror/commands";
import {
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  SearchQuery,
} from "@codemirror/search";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { extOf } from "$lib/format";
import { settings } from "$lib/stores/settings.svelte";
import { textColors } from "$lib/stores/textColors.svelte";
import { transformCase, convertLayout, type CaseMode, type LayoutMode } from "$lib/plugins";

// language packs
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { xml } from "@codemirror/lang-xml";

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

export function languageFor(path: string | null, content = "") {
  const ext = path ? extOf(path) : guessExtFromContent(content);
  switch (ext) {
    case "js": case "mjs": case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts": case "mts": case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "py": case "pyw":
      return python();
    case "rs":
      return rust();
    case "c": case "h": case "cpp": case "hpp": case "cc": case "hh": case "cxx":
      return cpp();
    case "json": case "jsonc":
      return json();
    case "yaml": case "yml":
      return yaml();
    case "html": case "htm":
      return html();
    case "css": case "scss": case "less":
      return css();
    case "md": case "markdown":
      return markdown();
    case "sql":
      return sql();
    case "go":
      return go();
    case "java":
      return java();
    case "php":
      return php();
    case "xml": case "svg": case "xsl": case "plist":
      return xml();
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
  const lang = languageFor(path, text);
  const st = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      syntaxHighlighting(alnaviHighlight),
      decorComp.of(settings.s.editorDecor ? makeDecorPlugin() : []),
      langComp.of(lang ? [lang] : []),
      wrapComp.of(settings.s.editorWordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.of(opts.readOnly ? EditorState.readOnly.of(true) : []),
      keymap.of([
        // FAR: Ctrl+PageUp/PageDown place the caret at the very start / very
        // end of the text (works in the editor and the read-only viewer)
        { key: "Ctrl-PageUp", run: cursorDocStart },
        { key: "Ctrl-PageDown", run: cursorDocEnd },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u.state.doc.toString());
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
          backgroundColor: "transparent",
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
  const lang = languageFor(path, text);
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: text },
    effects: [
      langComp.reconfigure(lang ? [lang] : []),
      wrapComp.reconfigure(settings.s.editorWordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.reconfigure(readOnly ? EditorState.readOnly.of(true) : []),
      decorComp.reconfigure(settings.s.editorDecor ? makeDecorPlugin() : []),
    ],
  });
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
    const apply = () => {
      try {
        v.scrollDOM.scrollTop = top;
      } catch {
        /* view destroyed meanwhile */
      }
    };
    // CodeMirror re-measures/re-resets the viewport of a freshly swapped doc
    // at various delays, so keep re-asserting the offset for a while
    requestAnimationFrame(() => requestAnimationFrame(apply));
    for (const ms of [120, 300, 600]) setTimeout(apply, ms);
  }
}

/** Rebuild decorations on the active editor (F9 toggle or rule/color edit). */
export function applyEditorDecor() {
  view?.dispatch({
    effects: decorComp.reconfigure(settings.s.editorDecor ? makeDecorPlugin() : []),
  });
}

export function lineColOf(v: EditorView): { line: number; col: number; sel: number } {
  const sel = v.state.selection.main;
  const line = v.state.doc.lineAt(sel.head);
  return { line: line.number, col: sel.head - line.from + 1, sel: Math.abs(sel.to - sel.from) };
}

export function currentView(): EditorView | null {
  return view;
}
