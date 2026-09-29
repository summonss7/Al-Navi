import { invoke } from "@tauri-apps/api/core";
import type {
  ConflictInfo,
  DirListing,
  DriveInfo,
  OpProgress,
  TextContent,
} from "./types";

// ---- FS ----
export const listDir = (path: string) => invoke<DirListing>("list_dir", { path });
export const freeSpace = (path: string) => invoke<[number, number]>("free_space", { path });
export const mkdir = (path: string) => invoke<void>("mkdir", { path });
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
export const copyPaths = (paths: string[], destDir: string) =>
  invoke<number>("copy_paths", { paths, destDir });
export const movePaths = (paths: string[], destDir: string) =>
  invoke<number>("move_paths", { paths, destDir });
export const deletePaths = (paths: string[], permanent: boolean) =>
  invoke<number>("delete_paths", { paths, permanent });
export const renamePath = (oldPath: string, newPath: string) =>
  invoke<void>("rename_path", { old: oldPath, new: newPath });
export const homePath = () => invoke<string>("home_path");
export const openPath = (path: string) => invoke<void>("open_path", { path });
export const runShell = (commandLine: string, cwd?: string) =>
  invoke<string>("run_shell", { commandLine, cwd: cwd ?? null });
export const opControl = (id: number, action: "pause" | "resume" | "cancel") =>
  invoke<void>("op_control", { id, action });
export const resolveConflict = (id: number, action: string) =>
  invoke<void>("resolve_conflict", { id, action });

// ---- System ----
export const drivesList = () => invoke<DriveInfo[]>("drives_list");
export const watchSet = (paths: string[]) => invoke<void>("watch_set", { paths });

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
