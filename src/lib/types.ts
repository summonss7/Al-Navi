export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number; // ms epoch
  attrs: string;
  isSymlink: boolean;
  isHidden: boolean;
  /** absolute path when the entry is not a plain child of the panel's dir
   *  (search results: full real path, name holds the display path) */
  fullPath?: string;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
  freeBytes: number;
  totalBytes: number;
}

export interface DriveInfo {
  name: string;
  mountPoint: string;
  kind: string; // fixed | removable | cd | network | ram | home | root | unknown
  totalBytes: number;
  freeBytes: number;
}

export interface OpProgress {
  id: number;
  phase: string; // scan | transfer | delete | trash | done
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  current: string;
  speed: number;
  cancelled: boolean;
  errors: OpError[];
}

export interface OpError {
  path: string;
  error: string;
}

export interface ConflictInfo {
  id: number;
  src: string;
  dst: string;
  isDir: boolean;
}

export interface TextContent {
  text: string;
  encoding: string;
  bom: boolean;
  eol: string; // crlf | lf | cr | mixed
  size: number;
  truncated: boolean;
}

export type SortMode = "name" | "ext" | "mtime" | "size" | "unsorted";

export interface SearchParams {
  root: string;
  mask: string;
  useRegex: boolean;
  text: string | null;
  textCaseSensitive: boolean;
  dateFrom: number | null; // ms epoch, file mtime >=
  dateTo: number | null;
  sizeFrom: number | null; // bytes
  sizeTo: number | null;
  findDirs: boolean;
}

export interface SearchHit {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  attrs: string;
  isSymlink: boolean;
  isHidden: boolean;
}

export interface SearchHitsEvent {
  id: number;
  hits: SearchHit[];
  scanned: number;
}

export interface SearchDoneEvent {
  id: number;
  cancelled: boolean;
  errors: string[];
  scanned: number;
  hits: number;
  elapsedMs: number;
}

export interface PanelTab {
  id: number;
  path: string;
  cursor: number;
  selected: Set<number>; // indexes into displayed entries
  history: string[];
  historyIndex: number;
}

export interface ShortcutMap {
  [digit: string]: string; // "0".."9" -> absolute path
}
