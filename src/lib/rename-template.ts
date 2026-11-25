/** FAR-style rename template: the typed target name may carry wildcards
 *  that take their characters from the current file name — "*.bak" keeps
 *  the stem, "new.*" keeps the extension, "?" copies one character of the
 *  old name at the current position. Port of FAR's ConvertWildcards
 *  (far2l src/mix/processname.cpp), applied only to the name component of
 *  the typed input; a name without wildcards comes back unchanged. */

/** Apply the template to one name. Wildcards borrow from srcName:
 *  - "?" copies the source character at the current position;
 *  - "*" copies the rest of the source until it matches the next template
 *    character — the template's (final) extension dot stops it at the
 *    source's own last dot, so "*.txt" replaces only the extension;
 *  - a literal emits itself and skips one source character, never a dot;
 *  - a template dot with wildcards still ahead ("new.*") skips the source
 *    to its extension, starting the rest of the template there.
 *  A trailing dot is dropped (Windows strips it anyway). */
function fillFromSource(srcName: string, tmpl: string): string {
  const dot = srcName.lastIndexOf(".");
  let s = 0; // position in the source name
  let out = "";
  let i = 0; // position in the template
  while (i < tmpl.length) {
    const c = tmpl[i++];
    if (c === "?") {
      if (s < srcName.length) out += srcName[s++];
    } else if (c === "*") {
      while (s < srcName.length) {
        // the star stops at the source's extension dot when the template
        // next wants its own final dot: "*.txt" keeps the name part
        if (tmpl[i] === "." && dot >= 0 && !tmpl.includes(".", i + 1)) {
          if (s === dot) break;
        } else if (srcName[s] === tmpl[i]) {
          break;
        }
        out += srcName[s++];
      }
    } else if (c === ".") {
      out += ".";
      // a template dot with wildcards still ahead skips the rest of the
      // source name part: "new.*" starts the star at the extension
      if (tmpl.indexOf("*", i) >= 0 || tmpl.indexOf("?", i) >= 0) {
        while (s < srcName.length && srcName[s++] !== ".") {
          /* skip to the source extension */
        }
      }
    } else {
      out += c;
      // a literal consumes one source character, but never a dot — the
      // extension must stay reachable for later wildcards
      if (s < srcName.length && srcName[s] !== ".") s++;
    }
  }
  return out.length && out.endsWith(".") ? out.slice(0, -1) : out;
}

/** Rename the entry currently named srcName according to typed: wildcards
 *  apply to the name component only, so "docs\\new.*" keeps the typed path
 *  part. Returns the input unchanged when it carries no wildcards. */
export function applyRenameTemplate(srcName: string, typed: string): string {
  const sep = Math.max(typed.lastIndexOf("\\"), typed.lastIndexOf("/"));
  const name = sep < 0 ? typed : typed.slice(sep + 1);
  if (!/[*?]/.test(name)) return typed;
  const filled = fillFromSource(srcName, name);
  // an empty result (e.g. a lone "?" against an empty source) must not
  // turn the typed path into a bare directory
  if (!filled) return typed;
  return sep < 0 ? filled : typed.slice(0, sep + 1) + filled;
}
