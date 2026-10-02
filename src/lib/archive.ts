/** M6 archives: the `archive://` virtual path scheme.
 *  URL shape: `archive://C:\dir\a.zip/inner/path` — the part before the first
 *  `/` is the archive file path (kept in `\` form like local panels use on
 *  Windows), the rest is the `/`-separated inner path. */

export const ARCHIVE_SCHEME = "archive://";

export function isArchivePath(p: string): boolean {
  return p.startsWith(ARCHIVE_SCHEME);
}

/** split a panel path into the archive file and the inner dir (""), normalizing
 *  the file part to backslashes so the first `/` always splits correctly */
export function splitArchiveUrl(url: string): { file: string; inner: string } {
  const rest = url.slice(ARCHIVE_SCHEME.length);
  const slash = rest.indexOf("/");
  const file = (slash === -1 ? rest : rest.slice(0, slash)).replace(/\//g, "\\");
  let inner = slash === -1 ? "" : rest.slice(slash + 1);
  while (inner.endsWith("/")) inner = inner.slice(0, -1);
  return { file, inner };
}

export function archiveUrl(file: string, inner: string): string {
  const f = file.replace(/\//g, "\\");
  return inner ? `${ARCHIVE_SCHEME}${f}/${inner}` : ARCHIVE_SCHEME + f;
}

/** joinPath for archive urls: the inner path always grows with `/` (joinPath
 *  itself would sniff `\` from the file part and break the url) */
export function joinArchivePath(url: string, name: string): string {
  const { file, inner } = splitArchiveUrl(url);
  return archiveUrl(file, inner ? `${inner}/${name}` : name);
}

/** archives the VFS can enter (extension gate; the backend also sniffs magic
 *  bytes, but Enter is only offered for known names) */
export function isArchiveFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".zip") || n.endsWith(".tar.gz") || n.endsWith(".tgz") || n.endsWith(".tar") || n.endsWith(".7z");
}

/** pack formats offered by Alt+F5: id is the backend `format` string */
export const PACK_FORMATS = [
  { id: "zip", ext: ".zip" },
  { id: "targz", ext: ".tar.gz" },
  { id: "tar", ext: ".tar" },
  { id: "7z", ext: ".7z" },
] as const;

export type PackFormatId = (typeof PACK_FORMATS)[number]["id"];
