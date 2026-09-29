use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct WatchState {
    watcher: Mutex<Option<notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>>>,
}

impl WatchState {
    pub fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub path: String,
}

/// Replace the set of watched directories (usually the two active panel paths).
/// Any change under them emits a `watch:changed` event with the touched path.
#[tauri::command]
pub fn watch_set(app: AppHandle, state: tauri::State<'_, WatchState>, paths: Vec<String>) -> Result<(), String> {
    let app2 = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(400),
        None,
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                for ev in events {
                    if let Some(p) = ev.event.paths.first() {
                        let _ = app2.emit("watch:changed", WatchEvent {
                            path: p.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    for p in &paths {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            let _ = debouncer.watch(&pb, notify::RecursiveMode::NonRecursive);
        }
    }

    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}
