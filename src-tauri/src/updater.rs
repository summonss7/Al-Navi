// In-app updates from the Aila update center (alnavi-039, concept —
// D:\Scheduler\UPDATES-SYSTEM.md §§3–5). GET manifest v2, semantic compare
// of versionName against CARGO_PKG_VERSION, download the portable-exe asset
// with a sha256 check, then rename-swap the running exe and restart:
// the running <app>.exe becomes <app>.exe.old (renaming a running exe is
// allowed on Windows, deleting is not), the fresh exe takes its place and is
// launched, and the .old leftover is removed on the next start (cleanup_old
// in the setup hook). Works from any install location — C:\Al-Navi or
// wherever the exe was launched from — because everything is relative to
// std::env::current_exe().
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

/// Manifest URL of the update channel. ALNAVI_UPDATES_URL overrides it —
/// that is how e2e tests point the app at a local manifest server.
fn manifest_url() -> String {
    std::env::var("ALNAVI_UPDATES_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://aila.skillcoin.pp.ua/updates/alnavi/manifest.json".into())
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version_name: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<UpdateAsset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// "latest" | "available" | "network-error" | "bad-manifest"
    pub status: String,
    pub current: String,
    pub latest: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    /// the chosen portable exe asset (Setup exes are skipped); present only
    /// when the manifest carries a usable one
    pub asset: Option<UpdateAsset>,
    pub error: Option<String>,
}

/// Numeric x.y[.z…] comparison: components compared as numbers, missing
/// tail counts as 0. Non-numeric junk after a component ends the number
/// (1.14.4-beta < 1.14.4 is accepted for simplicity — this channel only
/// ever publishes plain versions).
fn version_parts(v: &str) -> Vec<u64> {
    v.split('.')
        .map(|p| {
            let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().unwrap_or(0)
        })
        .collect()
}

fn version_lt(a: &str, b: &str) -> bool {
    let (a, b) = (version_parts(a), version_parts(b));
    let n = a.len().max(b.len());
    for i in 0..n {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

/// The portable exe the swap can install: .exe without "setup" in the name
/// (the channel also carries the NSIS Al-Navi-Setup-… exe for humans).
fn pick_asset(assets: &[UpdateAsset]) -> Option<&UpdateAsset> {
    assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe") && !a.name.to_ascii_lowercase().contains("setup"))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch the channel manifest and compare versions. Never returns Err —
/// an unreachable center must degrade to a status the UI can show or drop
/// silently (UPDATES-SYSTEM §5: "не удалось проверить" — не ошибка).
#[tauri::command]
pub async fn updater_check() -> UpdateCheck {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let mut r = UpdateCheck {
        status: "network-error".into(),
        current: current.clone(),
        latest: None,
        notes: None,
        published_at: None,
        asset: None,
        error: None,
    };
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => {
            r.error = Some(e);
            return r;
        }
    };
    let body = match client
        .get(manifest_url())
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .and_then(|res| res.error_for_status())
    {
        Ok(res) => res.text().await.unwrap_or_default(),
        Err(e) => {
            r.error = Some(e.to_string());
            return r;
        }
    };
    let m: Manifest = match serde_json::from_str(&body) {
        Ok(m) => m,
        Err(e) => {
            r.status = "bad-manifest".into();
            r.latest = None;
            r.error = Some(e.to_string());
            return r;
        }
    };
    r.latest = Some(m.version_name.clone());
    r.notes = m.notes;
    r.published_at = m.published_at;
    if version_lt(current.as_str(), m.version_name.as_str()) {
        r.status = "available".into();
        r.asset = pick_asset(&m.assets).cloned();
    } else {
        r.status = "latest".into();
    }
    r
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

/// Download the exe asset into %TEMP% while emitting "updater:progress"
/// events, verify sha256 against the manifest value and return the temp
/// path for updater_apply. A mismatch or a failed download removes the
/// partial file — nothing half-downloaded survives.
#[tauri::command]
pub async fn updater_download(app: AppHandle, url: String, sha256: String, size: u64) -> Result<String, String> {
    let client = http_client()?;
    let res = client
        .get(url)
        .timeout(std::time::Duration::from_secs(10 * 60))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?
        .error_for_status()
        .map_err(|e| format!("http: {e}"))?;
    let total = size.max(res.content_length().unwrap_or(0));
    let dest: PathBuf = std::env::temp_dir().join(format!("alnavi-update-{}.exe", std::process::id()));
    let mut file = tokio::fs::File::create(&dest).await.map_err(|e| format!("temp: {e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = u64::MAX;
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut stream = res.bytes_stream();
    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(format!("download: {e}"));
            }
            None => break,
        };
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| format!("write: {e}"))?;
        downloaded += chunk.len() as u64;
        // throttle: an event per ~256 KiB (or at completion)
        if last_emit == u64::MAX || downloaded.saturating_sub(last_emit) >= 256 * 1024 {
            let _ = app.emit("updater:progress", DownloadProgress { downloaded, total });
            last_emit = downloaded;
        }
    }
    let _ = app.emit("updater:progress", DownloadProgress { downloaded, total });
    drop(file);
    let got = format!("{:x}", hasher.finalize());
    if !got.eq_ignore_ascii_case(&sha256) {
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(format!("sha256 mismatch: expected {sha256}, got {got}"));
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// Remove the .old leftover from a previous update cycle (called from the
/// setup hook — by then the old binary is no longer running and Windows
/// allows its deletion).
pub fn cleanup_old() {
    if let Ok(exe) = std::env::current_exe() {
        let mut old = exe.into_os_string();
        old.push(".old");
        let _ = std::fs::remove_file(&old);
    }
}

/// The rename-swap: running exe → .old, downloaded exe → its place, spawn
/// the new binary, exit. The frontend persists the session/window state
/// before calling this — the process exit below skips the normal close
/// handlers.
#[tauri::command]
pub async fn updater_apply(app: AppHandle, path: String) -> Result<(), String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("downloaded file is gone: {path}"));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut old = exe.clone().into_os_string();
    old.push(".old");
    let old = PathBuf::from(old);
    // a stale .old from an earlier cycle would block the rename
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("rename current exe: {e} (folder writable?)"))?;
    if let Err(e) = std::fs::copy(&src, &exe) {
        // roll back so the app keeps running off the previous binary
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("copy new exe: {e}"));
    }
    let _ = std::fs::remove_file(&src);
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("restart: {e}"))?;
    app.exit(0);
    Ok(())
}
