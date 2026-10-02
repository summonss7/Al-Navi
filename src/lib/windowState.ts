import { getCurrentWindow } from "@tauri-apps/api/window";
import { saveJson } from "$lib/api";

/**
 * Window geometry memory: while the window is in its normal (not maximized)
 * state we track size/position; the maximized flag is stored alongside, so a
 * maximized window reopens maximized and un-maximizes back to the remembered
 * normal geometry. Saved debounced to window.json (survives a crash); the
 * restore happens in Rust setup before the window is shown.
 */

// null in a plain browser (dev preview, no Tauri backend)
const win = "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;

type Geometry = { x: number; y: number; w: number; h: number; maximized: boolean };

let normal: { x: number; y: number; w: number; h: number } | null = null;
let maximized = false;
let inited = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function trackGeometry() {
  if (!win) return;
  try {
    maximized = await win.isMaximized();
    if (!maximized) {
      const size = await win.innerSize();
      const pos = await win.outerPosition();
      normal = { x: pos.x, y: pos.y, w: size.width, h: size.height };
    }
    // skip the burst of events that fires while the window is being created
    if (inited) scheduleSave();
  } catch {
    /* window is gone during shutdown */
  }
}

function scheduleSave() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), 800);
}

/** persist the current geometry now (called on app exit before destroy) */
export async function flush() {
  if (!win) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    maximized = await win.isMaximized();
  } catch {
    return;
  }
  if (!normal) return;
  const g: Geometry = { ...normal, maximized };
  try {
    await saveJson("window.json", g);
  } catch {
    /* config dir unavailable — nothing to restore next time */
  }
}

/** start tracking resize/move; returns a cleanup fn */
export function init(): () => void {
  if (!win) return () => {};
  void trackGeometry().then(() => (inited = true));
  const p1 = win.onResized(() => void trackGeometry());
  const p2 = win.onMoved(() => void trackGeometry());
  return () => {
    void p1.then((u) => u());
    void p2.then((u) => u());
  };
}

export const windowState = { init, flush };
