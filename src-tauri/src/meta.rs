use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub build_time: String,
}

/// Version and build timestamp shown in the UI title bar.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_time: env!("AL_NAVI_BUILD_TIME").to_string(),
    }
}
