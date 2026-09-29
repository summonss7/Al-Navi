export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number; // ms epoch
  attrs: string;
  isSymlink: boolean;
  isHidden: boolean;
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
