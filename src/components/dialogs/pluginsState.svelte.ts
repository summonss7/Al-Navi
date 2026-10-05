// F11 editor plugins: the plugin -> mode two-level selection plus the mode
// application. Module state because the shared list keyboard navigation
// (listNav.svelte.ts) walks and activates both levels.
import { ui } from "$lib/stores/ui.svelte";
import { i18n } from "$lib/stores/i18n.svelte";
import { EDITOR_PLUGINS, type CaseMode, type LayoutMode } from "$lib/plugins";

/** selected plugin id, null = the top-level plugin list is shown */
export const pluginSel = $state<{ id: string | null }>({ id: null });

export function pluginModes() {
  return EDITOR_PLUGINS.find((p) => p.id === pluginSel.id)?.modes ?? [];
}

export function pluginIcon(): string {
  return EDITOR_PLUGINS.find((p) => p.id === pluginSel.id)?.icon ?? "ph-puzzle-piece";
}

export function resetPluginSel() {
  pluginSel.id = null;
}

async function applyCaseMode(mode: CaseMode) {
  ui.closeDialog();
  pluginSel.id = null;
  const { changeCaseCmd } = await import("$lib/editor/cm");
  const n = changeCaseCmd(mode);
  if (!n) ui.showToast(i18n.t("plug.noSel"));
}

async function applyLayoutMode(mode: LayoutMode) {
  ui.closeDialog();
  pluginSel.id = null;
  const { convertLayoutCmd } = await import("$lib/editor/cm");
  const n = convertLayoutCmd(mode);
  if (!n) ui.showToast(i18n.t("plug.noSel"));
}

/** run the chosen mode of the chosen F11 plugin */
export function applyPluginMode(pluginId: string, modeId: string) {
  if (pluginId === "layout") return void applyLayoutMode(modeId as LayoutMode);
  return void applyCaseMode(modeId as CaseMode);
}
