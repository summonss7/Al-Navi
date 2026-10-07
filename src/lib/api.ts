import { invoke } from "@tauri-apps/api/core";
import type {
  ConflictInfo,
  DirListing,
  DriveInfo,
  OpProgress,
  SearchDoneEvent,
  SearchHitsEvent,
  SearchParams,
  TextContent,
} from "./types";

// ---- FS ----
export const listDir = (path: string) => invoke<DirListing>("list_dir", { path });
export const computeDirSizes = (paths: string[]) => invoke<void>("dir_sizes", { paths });
export const freeSpace = (path: string) => invoke<[number, number]>("free_space", { path });
export const mkdir = (path: string) => invoke<void>("mkdir", { path });
/** Ctrl+A: `null` bit = leave unchanged (FAR's tri-state checkboxes) */
export interface AttrsPatch {
  readOnly: boolean | null;
  hidden: boolean | null;
  system: boolean | null;
  archive: boolean | null;
}
export const setAttributes = (paths: string[], a: AttrsPatch) =>
  invoke<void>("set_attributes", {
    paths,
    readOnly: a.readOnly,
    hidden: a.hidden,
    system: a.system,
    archive: a.archive,
  });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });
export const parentDir = (path: string) => invoke<string | null>("parent_dir", { path });

// ---- Text I/O ----
export const readText = (path: string, encoding?: string, fallback?: string) =>
  invoke<TextContent>("read_text", { path, encoding: encoding ?? null, fallback: fallback ?? null });
export const writeText = (
  path: string,
  content: string,
  encoding: string,
  eol: string,
) => invoke<void>("write_text", { path, content, encoding, eol });
export const readHex = (path: string, offset: number, len: number) =>
  invoke<{ data: number[]; fileSize: number }>("read_hex", { path, offset, len });

// ---- Operations ----
export const copyPaths = (paths: string[], dest: string) =>
  invoke<number>("copy_paths", { paths, dest });
export const movePaths = (paths: string[], dest: string) =>
  invoke<number>("move_paths", { paths, dest });
export const deletePaths = (paths: string[], permanent: boolean) =>
  invoke<number>("delete_paths", { paths, permanent });
export const renamePath = (oldPath: string, newPath: string) =>
  invoke<void>("rename_path", { old: oldPath, new: newPath });
export const renamePaths = (pairs: { old: string; new: string }[]) =>
  invoke<number>("rename_paths", { pairs });
export const homePath = () => invoke<string>("home_path");
export const openPath = (path: string) => invoke<void>("open_path", { path });
export const runShell = (commandLine: string, cwd?: string) =>
  invoke<void>("run_shell", { commandLine, cwd: cwd ?? null });
export const opControl = (id: number, action: "pause" | "resume" | "cancel") =>
  invoke<void>("op_control", { id, action });
export const resolveConflict = (id: number, action: string) =>
  invoke<void>("resolve_conflict", { id, action });

// ---- System ----
export const drivesList = () => invoke<DriveInfo[]>("drives_list");
export const watchSet = (paths: string[]) => invoke<void>("watch_set", { paths });

// ---- FTP ----
export const ftpConnect = (host: string, port: number, user: string, password: string) =>
  invoke<string>("ftp_connect", { host, port, user, password });
export const ftpList = (path: string) => invoke<DirListing>("ftp_list", { path });
export const ftpReadText = (path: string, encoding?: string, fallback?: string) =>
  invoke<TextContent>("ftp_read_text", { path, encoding: encoding ?? null, fallback: fallback ?? null });
export const ftpWriteText = (path: string, content: string, encoding: string, eol: string) =>
  invoke<void>("ftp_write_text", { path, content, encoding, eol });
export const ftpReadHex = (path: string, offset: number, len: number) =>
  invoke<{ data: number[]; fileSize: number }>("ftp_read_hex", { path, offset, len });
export const ftpMkdir = (path: string) => invoke<void>("ftp_mkdir", { path });
export const ftpRename = (oldPath: string, newPath: string) =>
  invoke<void>("ftp_rename", { old: oldPath, new: newPath });

// ---- SFTP (V2) — mirror of the FTP commands over SSH ----
export const sftpConnect = (host: string, port: number, user: string, password: string) =>
  invoke<string>("sftp_connect", { host, port, user, password });
export const sftpList = (path: string) => invoke<DirListing>("sftp_list", { path });
export const sftpReadText = (path: string, encoding?: string, fallback?: string) =>
  invoke<TextContent>("sftp_read_text", { path, encoding: encoding ?? null, fallback: fallback ?? null });
export const sftpWriteText = (path: string, content: string, encoding: string, eol: string) =>
  invoke<void>("sftp_write_text", { path, content, encoding, eol });
export const sftpReadHex = (path: string, offset: number, len: number) =>
  invoke<{ data: number[]; fileSize: number }>("sftp_read_hex", { path, offset, len });
export const sftpMkdir = (path: string) => invoke<void>("sftp_mkdir", { path });
export const sftpRename = (oldPath: string, newPath: string) =>
  invoke<void>("sftp_rename", { old: oldPath, new: newPath });

// ---- Archives (M6) ----
export const archiveList = (path: string) => invoke<DirListing>("archive_list", { path });
export const archiveReadText = (path: string, encoding?: string, fallback?: string) =>
  invoke<TextContent>("archive_read_text", { path, encoding: encoding ?? null, fallback: fallback ?? null });
export const archiveReadHex = (path: string, offset: number, len: number) =>
  invoke<{ data: number[]; fileSize: number }>("archive_read_hex", { path, offset, len });
export const extractPaths = (items: { url: string; dest: string }[]) =>
  invoke<number>("extract_paths", { items });
export const packPaths = (paths: string[], destFile: string, format: string) =>
  invoke<number>("pack_paths", { paths, destFile, format });
export const archiveAdd = (srcs: string[], destUrl: string, moveMode: boolean) =>
  invoke<number>("archive_add", { srcs, destUrl, moveMode });

// ---- Search ----
export const searchStart = (params: SearchParams) => invoke<number>("search_start", { params });
export const searchCancel = (id: number) => invoke<void>("search_cancel", { id });

// ---- Config persistence ----
export const loadJson = <T>(name: string) => invoke<T | null>("load_json", { name });
export const saveJson = (name: string, data: unknown) =>
  invoke<void>("save_json", { name, data });

// ---- App info ----
export interface AppInfo {
  version: string;
  buildTime: string;
}
export const appInfo = () => invoke<AppInfo>("app_info");

// ---- Events ----
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const onOpProgress = (cb: (p: OpProgress) => void): Promise<UnlistenFn> =>
  listen<OpProgress>("op:progress", (e) => cb(e.payload));
export const onOpConflict = (cb: (c: ConflictInfo) => void): Promise<UnlistenFn> =>
  listen<ConflictInfo>("op:conflict", (e) => cb(e.payload));
export const onWatchChanged = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<{ path: string }>("watch:changed", (e) => cb(e.payload.path));
export const onDirSize = (cb: (p: { path: string; size: number }) => void): Promise<UnlistenFn> =>
  listen<{ path: string; size: number }>("dirsize", (e) => cb(e.payload));
export const onSearchHit = (cb: (e: SearchHitsEvent) => void): Promise<UnlistenFn> =>
  listen<SearchHitsEvent>("search:hit", (e) => cb(e.payload));
export const onSearchDone = (cb: (e: SearchDoneEvent) => void): Promise<UnlistenFn> =>
  listen<SearchDoneEvent>("search:done", (e) => cb(e.payload));
