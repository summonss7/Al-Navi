<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { autofocus } from "./common";
  import { ftpSiteState, onHotkeyInput, submitFtpForm } from "./ftpState.svelte";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title">
      <i class="ph-duotone ph-globe-hemisphere-west"></i>
      {ftpSiteState.mode === "quick" ? i18n.t("ftp.quick") : ftpSiteState.mode === "add" ? i18n.t("ftp.add") : i18n.t("ftp.edit")}
    </div>
    <form class="dlg-body ftp-form" id="ftp-site-form" onsubmit={(e) => { e.preventDefault(); submitFtpForm(); }}>
      {#if ftpSiteState.mode !== "quick"}
        <label class="lbl" for="ftp-f-name">{i18n.t("ftp.name")}</label>
        <input id="ftp-f-name" bind:value={ftpSiteState.form.name} spellcheck="false" />
      {/if}
      <label class="lbl" for="ftp-f-host">{i18n.t("ftp.host")}</label>
      <input id="ftp-f-host" bind:value={ftpSiteState.form.host} use:autofocus placeholder="ftp.gnu.org" spellcheck="false" />
      <div class="ftp-row2">
        <div>
          <label class="lbl" for="ftp-f-port">{i18n.t("ftp.port")}</label>
          <input id="ftp-f-port" type="number" bind:value={ftpSiteState.form.port} min="1" max="65535" />
        </div>
        <div>
          <label class="lbl" for="ftp-f-user">{i18n.t("ftp.user")}</label>
          <input id="ftp-f-user" bind:value={ftpSiteState.form.user} spellcheck="false" />
        </div>
      </div>
      <label class="lbl" for="ftp-f-pass">{i18n.t("ftp.password")}</label>
      <input id="ftp-f-pass" type="password" bind:value={ftpSiteState.form.password} />
      {#if ftpSiteState.mode !== "quick"}
        <div class="ftp-row2" style="margin-top:10px">
          <div>
            <label class="lbl" for="ftp-f-key">{i18n.t("ftp.hotkey")}</label>
            <input
              id="ftp-f-key"
              value={ftpSiteState.form.hotkey ?? ""}
              oninput={onHotkeyInput}
              maxlength="1"
              placeholder="—"
              spellcheck="false"
              autocomplete="off"
            />
          </div>
          <div class="fc-hint" style="align-self:end; padding-bottom:8px">{i18n.t("ftp.hotkeyHint")}</div>
        </div>
      {/if}
      <div class="fc-hint" style="margin-top:10px">{i18n.t("ftp.hint")}</div>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={() => ui.openDialog("ftp")}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" type="submit" form="ftp-site-form">
        {ftpSiteState.mode === "quick" ? i18n.t("ftp.connect") : i18n.t("ftp.saveConnect")}
      </button>
    </div>
  </div>
</div>
