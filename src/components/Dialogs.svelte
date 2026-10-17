<script lang="ts">
  // Dialog router: decides which dialog component to render and owns the
  // window-level keyboard plumbing shared by all of them. Each dialog itself
  // (markup, local state, styles) lives in src/components/dialogs/.
  import { onMount } from "svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { clampListIdx, scrollListSel, onWindowKey } from "./dialogs/listNav.svelte";

  import ConfirmDialog from "$comp/dialogs/ConfirmDialog.svelte";
  import InputDialog from "$comp/dialogs/InputDialog.svelte";
  import PackDialog from "$comp/dialogs/PackDialog.svelte";
  import UnpackDialog from "$comp/dialogs/UnpackDialog.svelte";
  import AttrsDialog from "$comp/dialogs/AttrsDialog.svelte";
  import ProgressDialog from "$comp/dialogs/ProgressDialog.svelte";
  import ConflictDialog from "$comp/dialogs/ConflictDialog.svelte";
  import DrivesDialog from "$comp/dialogs/DrivesDialog.svelte";
  import FtpDialog from "$comp/dialogs/FtpDialog.svelte";
  import FtpSiteDialog from "$comp/dialogs/FtpSiteDialog.svelte";
  import SearchDialog from "$comp/dialogs/SearchDialog.svelte";
  import WindowListDialog from "$comp/dialogs/WindowListDialog.svelte";
  import DirHistoryDialog from "$comp/dialogs/DirHistoryDialog.svelte";
  import CmdHistoryDialog from "$comp/dialogs/CmdHistoryDialog.svelte";
  import ViewHistoryDialog from "$comp/dialogs/ViewHistoryDialog.svelte";
  import UserMenuDialog from "$comp/dialogs/UserMenuDialog.svelte";
  import UserMenuItemDialog from "$comp/dialogs/UserMenuItemDialog.svelte";
  import MultiRenameDialog from "$comp/dialogs/MultiRenameDialog.svelte";
  import PluginsDialog from "$comp/dialogs/PluginsDialog.svelte";
  import MenuDialog from "$comp/dialogs/MenuDialog.svelte";
  import HelpDialog from "$comp/dialogs/HelpDialog.svelte";
  import FileColorsDialog from "$comp/dialogs/FileColorsDialog.svelte";
  import TextColorsDialog from "$comp/dialogs/TextColorsDialog.svelte";
  import EncodingDialog from "$comp/dialogs/EncodingDialog.svelte";
  import ErrorsDialog from "$comp/dialogs/ErrorsDialog.svelte";

  // capture phase: keys handled by a dialog must be stopped on the way down —
  // the editor's CodeMirror listens on its focused content DOM and would run
  // before a bubble-phase window listener (Enter inserted a newline while the
  // F11 plugins dialog was open)
  onMount(() => {
    window.addEventListener("keydown", onWindowKey, { capture: true });
    return () => window.removeEventListener("keydown", onWindowKey, { capture: true });
  });

  // clamp the list cursor into the live list length while list dialogs are
  // open, and keep the keyboard-cursor row visible while walking
  $effect(() => {
    clampListIdx();
  });
  $effect(() => {
    scrollListSel();
  });
</script>

{#if ui.dialog === "confirm" && ui.confirmReq}<ConfirmDialog />{/if}
{#if ui.dialog === "input" && ui.inputReq}<InputDialog />{/if}
{#if ui.dialog === "pack" && ui.packReq}<PackDialog />{/if}
{#if ui.dialog === "unpack" && ui.unpackReq}<UnpackDialog />{/if}
{#if ui.dialog === "attrs" && ui.attrsReq}<AttrsDialog />{/if}
{#if ui.dialog === "progress" && ops.op}<ProgressDialog />{/if}
{#if ui.dialog === "conflict" && ops.conflict}<ConflictDialog />{/if}
{#if ui.dialog === "drives"}<DrivesDialog />{/if}
{#if ui.dialog === "ftp"}<FtpDialog />{/if}
{#if ui.dialog === "ftpSite"}<FtpSiteDialog />{/if}
{#if ui.dialog === "search"}<SearchDialog />{/if}
{#if ui.dialog === "windowList"}<WindowListDialog />{/if}
{#if ui.dialog === "dirHistory"}<DirHistoryDialog />{/if}
{#if ui.dialog === "cmdHistory"}<CmdHistoryDialog />{/if}
{#if ui.dialog === "viewHist"}<ViewHistoryDialog />{/if}
{#if ui.dialog === "userMenu"}<UserMenuDialog />{/if}
{#if ui.dialog === "userMenuItem"}<UserMenuItemDialog />{/if}
{#if ui.dialog === "multiRename" && ui.multiRenameReq}<MultiRenameDialog />{/if}
{#if ui.dialog === "plugins"}<PluginsDialog />{/if}
{#if ui.dialog === "menu"}<MenuDialog />{/if}
{#if ui.dialog === "help"}<HelpDialog />{/if}
{#if ui.dialog === "fileColors"}<FileColorsDialog />{/if}
{#if ui.dialog === "textColors"}<TextColorsDialog />{/if}
{#if ui.dialog === "encoding"}<EncodingDialog />{/if}
{#if ui.dialog === "errors" && ui.errorText}<ErrorsDialog />{/if}
