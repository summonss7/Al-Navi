import { loadJson, saveJson } from "$lib/api";
import type { FtpSite } from "$lib/ftp";

/** Saved FTP connections (drive menu → FTP). Passwords are stored as plain
 *  text in ftp-sites.json — the dialog says so. */
class FtpSitesStore {
  sites = $state<FtpSite[]>([]);
  private loaded = false;

  async init() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.sites = (await loadJson<FtpSite[]>("ftp-sites.json")) ?? [];
    } catch {
      // no backend (browser preview) or no saved file yet
    }
  }

  private persist() {
    saveJson("ftp-sites.json", this.sites).catch(() => {});
  }

  upsert(site: FtpSite) {
    const i = this.sites.findIndex((s) => s.id === site.id);
    if (i >= 0) {
      const next = [...this.sites];
      next[i] = site;
      this.sites = next;
    } else {
      this.sites = [...this.sites, site];
    }
    this.persist();
  }

  remove(id: string) {
    this.sites = this.sites.filter((s) => s.id !== id);
    this.persist();
  }
}

export const ftpSites = new FtpSitesStore();
