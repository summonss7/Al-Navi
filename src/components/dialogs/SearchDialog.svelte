<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { searchStore, isSearchPath } from "$lib/stores/search.svelte";
  import { isFtpPath } from "$lib/ftp";
  import { focusSelect } from "./common";

  // Alt+F7 find files
  interface SearchFormState {
    root: string;
    mask: string;
    useRegex: boolean;
    text: string;
    textCase: boolean;
    dateFrom: string; // yyyy-mm-dd from <input type=date>
    dateTo: string;
    sizeFrom: string; // bytes or 10k / 2m / 1g
    sizeTo: string;
    findDirs: boolean;
  }
  let searchForm = $state<SearchFormState>({
    root: "", mask: "", useRegex: false, text: "", textCase: false,
    dateFrom: "", dateTo: "", sizeFrom: "", sizeTo: "", findDirs: true,
  });

  function defaultSearchRoot(): string {
    const a = panels.active.path;
    if (!isFtpPath(a) && !isSearchPath(a)) return a;
    const b = panels.inactive.path;
    if (!isFtpPath(b) && !isSearchPath(b)) return b;
    return searchStore.originPath ?? "";
  }

  $effect(() => {
    const lp = searchStore.lastParams;
    searchForm = {
      // the folder always follows the current panel (FAR behavior); the last
      // search's root is only a last-resort fallback when no panel has a
      // local path (both FTP/search) — otherwise a stale root like C:\Windows
      // would keep overriding the panel the user is looking at
      root: defaultSearchRoot() || lp?.root || "",
      mask: lp?.mask ?? "*",
      useRegex: lp?.useRegex ?? false,
      text: lp?.text ?? "",
      textCase: lp?.textCaseSensitive ?? false,
      dateFrom: lp?.dateFrom != null ? datePickerOf(lp.dateFrom) : "",
      dateTo: lp?.dateTo != null ? datePickerOf(lp.dateTo) : "",
      sizeFrom: lp?.sizeFrom != null ? String(lp.sizeFrom) : "",
      sizeTo: lp?.sizeTo != null ? String(lp.sizeTo) : "",
      findDirs: lp?.findDirs ?? true,
    };
  });

  function datePickerOf(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** "10k" / "2m" / "1g" / plain bytes; null = empty, NaN = unparseable */
  function parseSizeInput(v: string): number | null {
    const t = v.trim().toLowerCase();
    if (!t) return null;
    const m = /^(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb|b)?$/.exec(t);
    if (!m) return NaN;
    const mult =
      m[2] === "k" || m[2] === "kb" ? 1024 :
      m[2] === "m" || m[2] === "mb" ? 1024 ** 2 :
      m[2] === "g" || m[2] === "gb" ? 1024 ** 3 : 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  function submitSearch() {
    const root = searchForm.root.trim();
    if (!root) {
      ui.showToast(i18n.t("search.rootMissing"));
      return;
    }
    const sizeFrom = parseSizeInput(searchForm.sizeFrom);
    const sizeTo = parseSizeInput(searchForm.sizeTo);
    if (Number.isNaN(sizeFrom) || Number.isNaN(sizeTo)) {
      ui.showToast(i18n.t("search.badSize"));
      return;
    }
    const dateFrom = searchForm.dateFrom ? new Date(searchForm.dateFrom + "T00:00:00").getTime() : null;
    const dateTo = searchForm.dateTo ? new Date(searchForm.dateTo + "T23:59:59.999").getTime() : null;
    ui.closeDialog();
    void searchStore.start({
      root,
      mask: searchForm.mask.trim(),
      useRegex: searchForm.useRegex,
      text: searchForm.text.trim() || null,
      textCaseSensitive: searchForm.textCase,
      dateFrom,
      dateTo,
      sizeFrom,
      sizeTo,
      findDirs: searchForm.findDirs,
    });
  }
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-magnifying-glass"></i>{i18n.t("search.title")}</div>
    <form class="dlg-body ftp-form" id="search-form" onsubmit={(e) => { e.preventDefault(); submitSearch(); }}>
      <label class="lbl" for="sr-f-root">{i18n.t("search.root")}</label>
      <input id="sr-f-root" bind:value={searchForm.root} spellcheck="false" style="width:100%" />
      <label class="lbl" for="sr-f-mask">{i18n.t("search.mask")}</label>
      <input id="sr-f-mask" bind:value={searchForm.mask} use:focusSelect placeholder="*" spellcheck="false" style="width:100%" />
      <label class="lbl check"><input type="checkbox" bind:checked={searchForm.useRegex} />{i18n.t("search.useRegex")}</label>
      <label class="lbl" for="sr-f-text">{i18n.t("search.text")}</label>
      <input id="sr-f-text" bind:value={searchForm.text} spellcheck="false" style="width:100%" />
      <label class="lbl check"><input type="checkbox" bind:checked={searchForm.textCase} />{i18n.t("search.textCase")}</label>
      <div class="ftp-row2">
        <div>
          <label class="lbl" for="sr-f-dfrom">{i18n.t("search.dateFrom")}</label>
          <input id="sr-f-dfrom" type="date" bind:value={searchForm.dateFrom} />
        </div>
        <div>
          <label class="lbl" for="sr-f-dto">{i18n.t("search.dateTo")}</label>
          <input id="sr-f-dto" type="date" bind:value={searchForm.dateTo} />
        </div>
      </div>
      <div class="ftp-row2">
        <div>
          <label class="lbl" for="sr-f-sfrom">{i18n.t("search.sizeFrom")}</label>
          <input id="sr-f-sfrom" placeholder="10k" bind:value={searchForm.sizeFrom} spellcheck="false" />
        </div>
        <div>
          <label class="lbl" for="sr-f-sto">{i18n.t("search.sizeTo")}</label>
          <input id="sr-f-sto" placeholder="1g" bind:value={searchForm.sizeTo} spellcheck="false" />
        </div>
      </div>
      <label class="lbl check"><input type="checkbox" bind:checked={searchForm.findDirs} />{i18n.t("search.findDirs")}</label>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" type="submit" form="search-form">{i18n.t("search.find")}</button>
    </div>
  </div>
</div>
