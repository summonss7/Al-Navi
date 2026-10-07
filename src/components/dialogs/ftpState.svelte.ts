// FTP/SFTP sites: the connect action (shared by the site list, the list
// keyboard navigation and the site form) plus the add/edit/quick-connect
// form state. The form is module state because the list dialog's buttons open
// the form pre-filled — the FtpSiteDialog component only binds into it.
// Object state: exported state must not be reassigned, only mutated through
// properties.
import { ui } from "$lib/stores/ui.svelte";
import { i18n } from "$lib/stores/i18n.svelte";
import { panels } from "$lib/stores/panels.svelte";
import { ftpSites } from "$lib/stores/ftpSites.svelte";
import { remoteConnect } from "$lib/ftp";
import { normalizeHotkeyChar } from "$lib/keymap";
import { newFtpSite, type FtpSite } from "$lib/ftp";

export const ftpSiteState = $state<{ form: FtpSite; mode: "quick" | "add" | "edit" }>({
  form: newFtpSite(),
  mode: "add",
});

export async function ftpConnectSite(site: FtpSite, save: boolean) {
  if (!site.host.trim()) {
    ui.showToast(i18n.t("ftp.hostMissing"));
    return;
  }
  if (save) {
    ftpSites.upsert({ ...site, name: site.name.trim() || site.host.trim() });
  }
  try {
    const root = await remoteConnect(site);
    const panel = ui.drivesFor === "left" ? panels.left : panels.right;
    panels.activeSide = ui.drivesFor;
    await panel.chdir(root);
    panels.pushDirHistory(root);
    ui.closeDialog();
  } catch (e) {
    ui.showError(String(e));
  }
}

/** the drive menu's FTP/SFTP rows open the same list — preset which protocol
 *  new sites get in the Add/Quick forms */
export function presetFtpScheme(secure: boolean) {
  if (ftpSiteState.mode === "edit") return;
  ftpSiteState.form = newFtpSite(secure);
}

export function ftpQuick() {
  ftpSiteState.form = newFtpSite(ftpSiteState.form.secure ?? false);
  ftpSiteState.mode = "quick";
  ui.openDialog("ftpSite");
}

export function ftpAdd() {
  ftpSiteState.form = newFtpSite(ftpSiteState.form.secure ?? false);
  ftpSiteState.mode = "add";
  ui.openDialog("ftpSite");
}

export function ftpEdit(idx: number) {
  const s = ftpSites.sites[idx];
  if (!s) return;
  ftpSiteState.form = { ...s };
  ftpSiteState.mode = "edit";
  ui.openDialog("ftpSite");
}

export function ftpDelete(idx: number) {
  const s = ftpSites.sites[idx];
  if (s) ftpSites.remove(s.id);
}

/** the jump-key field keeps a single normalized char: latin letters map
 *  from ЙЦУКЕН (Ф -> A), anything that is not a letter/digit is dropped */
export function onHotkeyInput(e: Event) {
  const el = e.currentTarget as HTMLInputElement;
  el.value = normalizeHotkeyChar(el.value) ?? "";
  ftpSiteState.form.hotkey = el.value;
}

/** the protocol toggle switches the form's port default with it */
export function onSchemeInput(secure: boolean) {
  ftpSiteState.form.secure = secure;
  if (secure && (ftpSiteState.form.port === 21 || !ftpSiteState.form.port)) {
    ftpSiteState.form.port = 22;
  } else if (!secure && (ftpSiteState.form.port === 22 || !ftpSiteState.form.port)) {
    ftpSiteState.form.port = 21;
  }
}

export function submitFtpForm() {
  const form = ftpSiteState.form;
  if (ftpSiteState.mode === "quick") {
    void ftpConnectSite(form, false);
    return;
  }
  const hk = (form.hotkey ?? "").trim() ? normalizeHotkeyChar(form.hotkey!) : null;
  if ((form.hotkey ?? "").trim() && !hk) {
    ui.showToast(i18n.t("ftp.hotkeyBad"));
    return;
  }
  const rival = hk ? ftpSites.sites.find((s) => s.hotkey === hk && s.id !== form.id) : undefined;
  if (rival) {
    ui.showToast(i18n.t("ftp.hotkeyTaken", { key: hk!, name: rival.name || rival.host }));
    return;
  }
  void ftpConnectSite({ ...form, hotkey: hk ?? undefined }, true);
}
