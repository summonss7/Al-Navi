// F2 user menu: item activation (Enter / click runs the command through the
// command line) plus the add/edit form target. The form fields themselves live
// in the UserMenuItemDialog component — it seeds from the edit target and
// submits through submitUmForm, so no cross-module field bindings are needed.
// Object state: exported state must not be reassigned, only mutated through
// properties.
import { ui } from "$lib/stores/ui.svelte";
import { i18n } from "$lib/stores/i18n.svelte";
import { cmdline, runCommand as runCmdline } from "$lib/stores/cmdline.svelte";
import { userMenu, expandUserPlaceholders, type UserMenuItem } from "$lib/stores/userMenu.svelte";

export const umFormState = $state<{ mode: "add" | "edit"; editId: number | undefined }>({
  mode: "add",
  editId: undefined,
});

export function umAdd() {
  umFormState.mode = "add";
  umFormState.editId = undefined;
  ui.openDialog("userMenuItem");
}

export function umEdit(idx: number) {
  const it = userMenu.items[idx];
  if (!it) return;
  umFormState.mode = "edit";
  umFormState.editId = it.id;
  ui.openDialog("userMenuItem");
}

export async function umDelete(idx: number) {
  const it = userMenu.items[idx];
  if (!it) return;
  ui.closeDialog();
  if (await ui.askConfirm(i18n.t("umenu.delConfirm", { title: it.title }))) {
    userMenu.remove(it.id);
  }
  ui.openDialog("userMenu");
}

export function submitUmForm(title: string, command: string) {
  if (!command.trim()) return;
  userMenu.upsert({
    id: umFormState.editId,
    title: title.trim() || command.trim(),
    command: command.trim(),
  });
  ui.openDialog("userMenu");
}

/** run a menu command exactly as if typed on the command line: placeholders
 *  expand against the panel cursor, the result lands in Alt+F8 history and
 *  goes through runCommand (cd / ftp:// / external shell) */
export function execUserMenuItem(item: UserMenuItem) {
  const final = expandUserPlaceholders(item.command);
  ui.closeDialog();
  cmdline.setText(final);
  cmdline.submit();
  void runCmdline(final);
}
