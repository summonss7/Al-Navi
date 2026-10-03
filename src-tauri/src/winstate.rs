use serde::Deserialize;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

/// Geometry saved by the frontend (src/lib/windowState.ts) in window.json.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedGeometry {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
}

fn saved_geometry() -> Option<SavedGeometry> {
    let p = crate::config::config_dir().join("window.json");
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

/// True when a point lands inside one of the currently attached monitors —
/// a position from a disconnected monitor would strand the titlebar offscreen.
fn point_on_screen(win: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = win.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
    })
}

/// Physical floor for a saved record: a window closed while minimized
/// persists its parked geometry (Windows stashes it at −32000 sized ~181×24)
/// — such a record is corruption, not a window to bring back as a slit.
const MIN_SAVED_W: u32 = 200;
const MIN_SAVED_H: u32 = 150;

/// Clamp a saved size to sane physical bounds: never smaller than the app
/// minimum (tauri.conf.json: 940×560 logical) and never bigger than the
/// largest live monitor — the display setup may have changed since the save.
fn clamped_size(w: u32, h: u32, scale: f64, max_w: u32, max_h: u32) -> (u32, u32) {
    let w = w.max((940.0 * scale) as u32).min(max_w);
    let h = h.max((560.0 * scale) as u32).min(max_h);
    (w, h)
}

/// Restore the saved geometry (tauri.conf.json starts the window hidden) and
/// show it. Without a saved state — or with an offscreen one — the window
/// keeps its configured centered default.
pub fn restore_and_show(win: &WebviewWindow) {
    let g = saved_geometry();
    if let Some(g) = &g {
        if g.w >= MIN_SAVED_W && g.h >= MIN_SAVED_H {
            let scale = win.scale_factor().unwrap_or(1.0).max(1.0);
            // unknown monitor setup -> no upper cap, just the app minimum
            let (max_w, max_h) = win
                .available_monitors()
                .ok()
                .and_then(|ms| {
                    ms.iter()
                        .max_by_key(|m| m.size().width.saturating_mul(m.size().height))
                        .map(|m| (m.size().width, m.size().height))
                })
                .unwrap_or((u32::MAX, u32::MAX));
            let (w, h) = clamped_size(g.w, g.h, scale, max_w, max_h);
            let _ = win.set_size(PhysicalSize::new(w, h));
            // the titlebar must stay reachable: validate against live monitors
            let anchor_x = g.x + (g.w as i32 / 2).min(200);
            if point_on_screen(win, anchor_x, g.y + 20) {
                let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
            }
        }
    }
    let _ = win.show();
    // maximize only after show: Windows drops the maximized state of a
    // still-hidden window
    if g.as_ref().map(|g| g.maximized) == Some(true) {
        let _ = win.maximize();
    }
}
