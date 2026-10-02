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

/// Restore the saved geometry (tauri.conf.json starts the window hidden) and
/// show it. Without a saved state — or with an offscreen one — the window
/// keeps its configured centered default.
pub fn restore_and_show(win: &WebviewWindow) {
    let g = saved_geometry();
    if let Some(g) = &g {
        if g.w > 0 && g.h > 0 {
            let _ = win.set_size(PhysicalSize::new(g.w, g.h));
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
