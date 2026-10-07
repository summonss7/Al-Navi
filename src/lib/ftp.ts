// FTP/SFTP path helpers. A panel addresses a server as
// "ftp://user@host:port/dir…" or "sftp://user@host:port/dir…" — the password
// never appears in a path (it lives in the Rust session and in ftp-sites.json).
// A site with secure=true is SFTP (SSH, default port 22); without it — plain
// FTP (port 21). The remote* helpers dispatch each call to the matching
// backend command so callers can stay scheme-agnostic.

import {
  ftpConnect,
  ftpList,
  ftpReadText,
  ftpWriteText,
  ftpReadHex,
  ftpMkdir,
  ftpRename,
  sftpConnect,
  sftpList,
  sftpReadText,
  sftpWriteText,
  sftpReadHex,
  sftpMkdir,
  sftpRename,
} from "$lib/api";

export interface FtpSite {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  /** jump key of the site in the FTP/SFTP list: one letter or digit ("2", "A") */
  hotkey?: string;
  /** true = SFTP over SSH (default port 22); absent/false = plain FTP */
  secure?: boolean;
}

/** the drive menu (Alt+F1/F2) jumps to the FTP list on this key — drives
 *  have letters only, so a digit never collides with them */
export const FTP_DRIVE_KEY = "2";
/** the drive menu jumps to the same site list (SFTP preset) on this key */
export const SFTP_DRIVE_KEY = "3";

export function isFtpPath(p: string): boolean {
  return p.startsWith("ftp://");
}

export function isSftpPath(p: string): boolean {
  return p.startsWith("sftp://");
}

/** any remote panel path: ftp:// or sftp:// */
export function isRemotePath(p: string): boolean {
  return isFtpPath(p) || isSftpPath(p);
}

/** "ftp://user@host:port/a/b" -> "ftp://user@host:port" (no trailing slash);
 *  scheme-aware, so sftp:// paths work too */
export function remoteAuthority(p: string): string {
  const scheme = isSftpPath(p) ? "sftp://" : "ftp://";
  const rest = p.slice(scheme.length);
  const slash = rest.indexOf("/");
  return scheme + (slash < 0 ? rest : rest.slice(0, slash));
}

/** kept for the FTP-only call sites */
export function ftpAuthority(p: string): string {
  return remoteAuthority(p);
}

/** site -> panel path of the server root */
export function ftpRootOf(site: Pick<FtpSite, "host" | "port" | "user" | "secure">): string {
  const scheme = site.secure ? "sftp" : "ftp";
  const user = site.user.trim() || "anonymous";
  const port = site.port || (site.secure ? 22 : 21);
  return `${scheme}://${user}@${site.host.trim()}:${port}`;
}

let siteSeq = 0;
export const nextFtpSiteId = () => `s${Date.now().toString(36)}${(siteSeq++).toString(36)}`;

export function newFtpSite(secure = false): FtpSite {
  return {
    id: nextFtpSiteId(),
    name: "",
    host: "",
    port: secure ? 22 : 21,
    user: "anonymous",
    password: "",
    secure,
  };
}

// ---- scheme-aware dispatchers over the backend commands ----

export function remoteConnect(site: Pick<FtpSite, "host" | "port" | "user" | "password" | "secure">) {
  return site.secure
    ? sftpConnect(site.host, site.port || 22, site.user, site.password)
    : ftpConnect(site.host, site.port || 21, site.user, site.password);
}

export function remoteList(path: string) {
  return isSftpPath(path) ? sftpList(path) : ftpList(path);
}

export function remoteReadText(path: string, encoding?: string, fallback?: string) {
  return isSftpPath(path)
    ? sftpReadText(path, encoding, fallback)
    : ftpReadText(path, encoding, fallback);
}

export function remoteWriteText(path: string, content: string, encoding: string, eol: string) {
  return isSftpPath(path)
    ? sftpWriteText(path, content, encoding, eol)
    : ftpWriteText(path, content, encoding, eol);
}

export function remoteReadHex(path: string, offset: number, len: number) {
  return isSftpPath(path) ? sftpReadHex(path, offset, len) : ftpReadHex(path, offset, len);
}

export function remoteMkdir(path: string) {
  return isSftpPath(path) ? sftpMkdir(path) : ftpMkdir(path);
}

export function remoteRename(oldPath: string, newPath: string) {
  return isSftpPath(oldPath) ? sftpRename(oldPath, newPath) : ftpRename(oldPath, newPath);
}
