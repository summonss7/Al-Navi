import { EditorView, keymap, highlightActiveLine, lineNumbers, drawSelection, highlightSpecialChars } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  deleteLine as cmDeleteLine,
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
      langComp.of(lang ? [lang] : []),
      wrapComp.of(settings.s.editorWordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.of(opts.readOnly ? EditorState.readOnly.of(true) : []),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u.state.doc.toString());
      }),
      EditorView.theme({
        "&": { height: "100%", fontSize: "13.5px" },
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
    ],
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
