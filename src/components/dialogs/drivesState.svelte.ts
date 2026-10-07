// Alt+F1/F2 drive list: the list data and the "switch panel to drive" action.
// Lives in a module (not the DrivesDialog component) because the shared list
// keyboard navigation (listNav.svelte.ts) activates drives and jumps by drive
// letters from the window-level key handler. Object state: exported state
// must not be reassigned, only mutated through properties.
import { ui } from "$lib/stores/ui.svelte";
import { panels } from "$lib/stores/panels.svelte";
import { drivesList } from "$lib/api";
import { presetFtpScheme } from "./ftpState.svelte";
import type { DriveInfo } from "$lib/types";

export const drivesState = $state<{ list: DriveInfo[] }>({ list: [] });

/** reload the list; the FTP and SFTP entries ride at the end (jump keys:
 *  2 = FTP, 3 = SFTP; drive letters never collide with digits) */
export function loadDrives() {
  drivesList()
    .then(
      (d) =>
        (drivesState.list = [
          ...d,
          { name: "FTP", mountPoint: "ftp://", kind: "ftp", totalBytes: 0, freeBytes: 0 },
          { name: "SFTP", mountPoint: "sftp://", kind: "sftp", totalBytes: 0, freeBytes: 0 },
        ]),
    )
    .catch(console.error);
}

export async function pickDrive(d: DriveInfo) {
  if (d.kind === "ftp" || d.kind === "sftp") {
    // both rows open the shared site list; new sites preset to that protocol
    presetFtpScheme(d.kind === "sftp");
    ui.openDialog("ftp");
    return;
  }
  const panel = ui.drivesFor === "left" ? panels.left : panels.right;
  panels.activeSide = ui.drivesFor;
  await panel.chdir(d.mountPoint);
  panels.pushDirHistory(d.mountPoint);
  ui.closeDialog();
}
