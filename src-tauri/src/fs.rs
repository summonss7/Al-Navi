use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EntryDto {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    pub attrs: String,
    pub is_symlink: bool,
    pub is_hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<EntryDto>,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[cfg(windows)]
const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
#[cfg(windows)]
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
#[cfg(windows)]
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
#[cfg(windows)]
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;
#[cfg(windows)]
const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;

#[cfg(unix)]
fn unix_attrs(md: &fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    let mode = md.permissions().mode();
    let mut s = String::with_capacity(9);
    for shift in [6, 3, 0] {
        let bits = (mode >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

#[cfg(windows)]
fn win_attrs(md: &fs::Metadata) -> String {
    use std::os::windows::fs::MetadataExt;
    let a = md.file_attributes();
    let mut s = String::new();
    if a & FILE_ATTRIBUTE_READONLY != 0 {
        s.push('R');
    }
    if a & FILE_ATTRIBUTE_HIDDEN != 0 {
        s.push('H');
    }
    if a & FILE_ATTRIBUTE_SYSTEM != 0 {
        s.push('S');
    }
    if a & FILE_ATTRIBUTE_COMPRESSED != 0 {
        s.push('C');
    }
    if a & FILE_ATTRIBUTE_ARCHIVE != 0 {
        s.push('A');
    }
    s
}

fn mtime_ms(md: &fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn build_entry(path: &Path, name: String) -> Option<EntryDto> {
    let md = fs::symlink_metadata(path).ok()?;
    let is_symlink = md.file_type().is_symlink();
    // For symlinks follow the target to know whether it points to a directory
    let is_dir = if is_symlink {
        fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
    } else {
        md.is_dir()
    };
    #[cfg(windows)]
    let attrs = win_attrs(&md);
    #[cfg(unix)]
    let attrs = unix_attrs(&md);
    #[cfg(windows)]
    let is_hidden = {
        use std::os::windows::fs::MetadataExt;
        md.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    };
    #[cfg(unix)]
    let is_hidden = name.starts_with('.');
    Some(EntryDto {
        size: if is_dir { 0 } else { md.len() },
        mtime: mtime_ms(&md),
        name,
        is_dir,
        attrs,
        is_symlink,
        is_hidden,
    })
}

/// Free/total space of the filesystem that contains `path` (via sysinfo mount points).
fn sysinfo_free_total(path: &Path) -> (u64, u64) {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    // canonicalize() yields a \\?\-prefixed verbatim path on Windows, which never
    // component-matches plain mount points like "C:\" — strip the prefix
    let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let abs = match canon.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(s) => PathBuf::from(s),
        None => canon,
    };
    let mut best: Option<(usize, u64, u64)> = None; // (mount length, free, total)
    for d in disks.list() {
        let mp = d.mount_point();
        if abs.starts_with(mp) {
            let len = mp.as_os_str().len();
            if best.as_ref().map(|b| len > b.0).unwrap_or(true) {
                best = Some((len, d.available_space(), d.total_space()));
            }
        }
    }
    best.map(|(_, f, t)| (f, t)).unwrap_or((0, 0))
}

fn list_dir_blocking(path: String) -> Result<DirListing, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let rd = fs::read_dir(&p).map_err(|e| format!("{}: {}", path, e))?;
    let mut entries = Vec::new();
    for item in rd {
        let Ok(item) = item else { continue };
        let Ok(raw_name) = item.file_name().into_string() else { continue };
        if let Some(e) = build_entry(&item.path(), raw_name) {
            entries.push(e);
        }
    }
    // ".." is added by the frontend; sorting is locale-aware on the JS side
    let (free, total) = sysinfo_free_total(&p);
    Ok(DirListing {
        path,
        entries,
        free_bytes: free,
        total_bytes: total,
    })
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

/// Generation for dir_sizes workers: a new call invalidates the previous one,
/// so fast navigation never piles up zombie walks.
static DIR_SIZE_GEN: AtomicU64 = AtomicU64::new(0);

/// Recursively size each folder and emit a `dirsize` event ({ path, size }) per
/// result. Runs detached; the command returns immediately.
#[tauri::command]
pub fn dir_sizes(app: tauri::AppHandle, paths: Vec<String>) {
    let gen = DIR_SIZE_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        for p in paths {
            if DIR_SIZE_GEN.load(Ordering::Relaxed) != gen {
                break; // superseded by a newer request
            }
            let pb = PathBuf::from(&p);
            if !pb.is_dir() {
                continue;
            }
            // sum of plain files, symlinks not followed — an "≈" size, like FAR
            let size: u64 = walkdir::WalkDir::new(&pb)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
                .sum();
            let _ = app.emit("dirsize", serde_json::json!({ "path": p, "size": size }));
        }
    });
}

#[tauri::command]
pub async fn free_space(path: String) -> Result<(u64, u64), String> {
    tauri::async_runtime::spawn_blocking(move || sysinfo_free_total(&PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mkdir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&path).map_err(|e| format!("{}: {}", path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || Path::new(&path).exists())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn parent_dir(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn home_path() -> Result<String, String> {
    dirs::home_dir()
        .map(|d| d.to_string_lossy().to_string())
        .ok_or_else(|| "no home directory".to_string())
}

/// Execute a shell command line (cmd.exe on Windows, sh on Unix).
#[tauri::command]
pub async fn run_shell(command_line: String, cwd: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use std::process::Command;
        let mut c;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c = Command::new("cmd");
            c.args(["/C", &command_line]);
            if let Some(dir) = &cwd {
                c.current_dir(dir);
            }
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        #[cfg(unix)]
        {
            c = Command::new("sh");
            c.arg("-c").arg(&command_line);
            if let Some(dir) = &cwd {
                c.current_dir(dir);
            }
        }
        let out = c
            .output()
            .map_err(|e| format!("{}: {}", command_line, e))?;
        Ok(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a file/folder with the OS handler (Explorer / xdg-open).
#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // explore/select if directory, otherwise ShellExecute via cmd start
            let status = std::process::Command::new("cmd")
                .args(["/C", "start", "", &path])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status()
                .map_err(|e| e.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("failed to open: {}", path))
            }
        }
        #[cfg(unix)]
        {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .status()
                .map_err(|e| e.to_string())?
                .success()
                .then_some(())
                .ok_or_else(|| format!("failed to open: {}", path))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
