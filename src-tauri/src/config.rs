use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub(crate) fn config_dir() -> PathBuf {
    let base = dirs::config_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("al-navi");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Generic JSON persistence: load `settings.json`, `keymap.json`, etc.
/// from the OS config dir (%APPDATA%\al-navi on Windows, ~/.config/al-navi on Linux).
#[tauri::command]
pub fn load_json(name: String) -> Result<Option<Value>, String> {
    if name.contains("..") || name.contains('/') || name.contains('\\') || !name.ends_with(".json") {
        return Err("invalid config name".into());
    }
    let p = config_dir().join(&name);
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("{}: {}", name, e)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn save_json(name: String, data: Value) -> Result<(), String> {
    if name.contains("..") || name.contains('/') || name.contains('\\') || !name.ends_with(".json") {
        return Err("invalid config name".into());
    }
    let p = config_dir().join(&name);
    let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| format!("{}: {}", name, e))
}
