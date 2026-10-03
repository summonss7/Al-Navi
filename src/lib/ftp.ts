// FTP path helpers. A panel addresses an FTP server as
// "ftp://user@host:port/dir..." — the password never appears in a path (it
// lives in the Rust session and in ftp-sites.json).

export interface FtpSite {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  /** jump key of the site in the FTP list: one letter or digit ("2", "A") */
  hotkey?: string;
}

/** the drive menu (Alt+F1/F2) jumps to the FTP list on this key — drives
 *  have letters only, so a digit never collides with them */
export const FTP_DRIVE_KEY = "2";

export function isFtpPath(p: string): boolean {
  return p.startsWith("ftp://");
}

/** "ftp://user@host:port/a/b" -> "ftp://user@host:port" (no trailing slash) */
export function ftpAuthority(p: string): string {
  const rest = p.slice("ftp://".length);
  const slash = rest.indexOf("/");
  return "ftp://" + (slash < 0 ? rest : rest.slice(0, slash));
}

/** site -> panel path of the server root */
export function ftpRootOf(site: Pick<FtpSite, "host" | "port" | "user">): string {
  const user = site.user.trim() || "anonymous";
  const port = site.port || 21;
  return `ftp://${user}@${site.host.trim()}:${port}`;
}

let siteSeq = 0;
export const nextFtpSiteId = () => `s${Date.now().toString(36)}${(siteSeq++).toString(36)}`;

export function newFtpSite(): FtpSite {
  return { id: nextFtpSiteId(), name: "", host: "", port: 21, user: "anonymous", password: "" };
}
