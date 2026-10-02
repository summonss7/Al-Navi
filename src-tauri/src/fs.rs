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

pub(crate) fn build_entry(path: &Path, md: &fs::Metadata, name: String) -> Option<EntryDto> {
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

/// Free/total space of the filesystem that contains `path`.
#[cfg(windows)]
fn free_total(path: &Path) -> (u64, u64) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        // one direct volume query for the path — unlike a full disk-list
        // enumeration it can't stall on a stale network drive
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let (mut free, mut total) = (0u64, 0u64);
    let ok =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) };
    if ok != 0 {
        (free, total)
    } else {
        (0, 0)
    }
}

/// Free/total space of the filesystem that contains `path` (via sysinfo mount points).
#[cfg(unix)]
fn free_total(path: &Path) -> (u64, u64) {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let abs = canon.to_path_buf();
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
        // DirEntry::metadata comes free with the directory read on Windows
        // (no second stat per entry, unlike symlink_metadata(path))
        if let Ok(md) = item.metadata() {
            if let Some(e) = build_entry(&item.path(), &md, raw_name) {
                entries.push(e);
            }
        }
    }
    // ".." is added by the frontend; sorting is locale-aware on the JS side
    let (free, total) = free_total(&p);
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
    tauri::async_runtime::spawn_blocking(move || free_total(&PathBuf::from(path)))
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

/// Set/clear one requested bit in a Windows attribute mask; `None` leaves it
/// untouched, like FAR's tri-state checkboxes in Ctrl+A.
#[cfg(windows)]
fn apply_bit(mask: &mut u32, bit: u32, want: Option<bool>) {
    if let Some(want) = want {
        if want {
            *mask |= bit;
        } else {
            *mask &= !bit;
        }
    }
}

/// Merge the requested R/O/H/S/A changes into `cur`, passing every other bit
/// (DIRECTORY, COMPRESSED, REPARSE_POINT…) through unchanged — zeroing those
/// would corrupt the mask.
#[cfg(windows)]
fn merge_attrs(
    cur: u32,
    read_only: Option<bool>,
    hidden: Option<bool>,
    system: Option<bool>,
    archive: Option<bool>,
) -> u32 {
    let mut m = cur;
    apply_bit(&mut m, FILE_ATTRIBUTE_READONLY, read_only);
    apply_bit(&mut m, FILE_ATTRIBUTE_HIDDEN, hidden);
    apply_bit(&mut m, FILE_ATTRIBUTE_SYSTEM, system);
    apply_bit(&mut m, FILE_ATTRIBUTE_ARCHIVE, archive);
    m
}

#[cfg(windows)]
fn set_attributes_blocking(
    paths: &[String],
    read_only: Option<bool>,
    hidden: Option<bool>,
    system: Option<bool>,
    archive: Option<bool>,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileAttributesW(filename: *const u16, attributes: u32) -> i32;
    }
    let mut errors: Vec<String> = Vec::new();
    for path in paths {
        // symlink_metadata: for a symlink the link's own mask is what
        // SetFileAttributesW will rewrite, so read the same thing
        let res = fs::symlink_metadata(path)
            .map_err(|e| format!("{}: {}", path, e))
            .and_then(|md| {
                let attrs = merge_attrs(md.file_attributes(), read_only, hidden, system, archive);
                let mut wide: Vec<u16> = Path::new(path).as_os_str().encode_wide().collect();
                wide.push(0);
                if unsafe { SetFileAttributesW(wide.as_ptr(), attrs) } != 0 {
                    Ok(())
                } else {
                    Err(format!("{}: {}", path, std::io::Error::last_os_error()))
                }
            });
        if let Err(e) = res {
            errors.push(e);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

#[cfg(unix)]
fn set_attributes_blocking(
    paths: &[String],
    read_only: Option<bool>,
    hidden: Option<bool>,
    system: Option<bool>,
    archive: Option<bool>,
) -> Result<(), String> {
    // hidden/system/archive are Windows-only bits; the read-only permission
    // is the only one a Unix filesystem can express
    if hidden.is_some() || system.is_some() || archive.is_some() {
        return Err("hidden/system/archive attributes are not supported on this platform".into());
    }
    let mut errors: Vec<String> = Vec::new();
    for path in paths {
        let res = fs::metadata(path).and_then(|md| {
            if let Some(ro) = read_only {
                let mut perm = md.permissions();
                perm.set_readonly(ro);
                fs::set_permissions(path, perm)?;
            }
            Ok(())
        });
        if let Err(e) = res {
            errors.push(format!("{}: {}", path, e));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// Ctrl+A attributes dialog: apply R/O/H/S/A to each path; `None` = unchanged.
#[tauri::command]
pub async fn set_attributes(
    paths: Vec<String>,
    read_only: Option<bool>,
    hidden: Option<bool>,
    system: Option<bool>,
    archive: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_attributes_blocking(&paths, read_only, hidden, system, archive)
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

/// Execute a shell command line FAR-style: a new visible console window runs
/// `cmd /C <line>`, so interactive programs (powershell, cmd, python …) get a
/// real console and plain output stays readable. `& pause` keeps the window
/// open after the command finishes (FAR also returns on a key press); `start`
/// lines skip the pause and `exit` closes before it ever runs.
#[tauri::command]
pub async fn run_shell(command_line: String, cwd: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::process::Command;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // raw_arg: cmd.exe must see the line verbatim — std's MSVC-style
            // quoting of `args` would litter it with literal backslashes
            let with_pause = if starts_with_start(&command_line) {
                command_line.clone()
            } else {
                format!("{} & pause", command_line)
            };
            let mut c = Command::new("cmd");
            c.raw_arg("/C").raw_arg(&with_pause);
            if let Some(dir) = &cwd {
                c.current_dir(dir);
            }
            c.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
            // .status(): no pipes — the child writes into its own console.
            // A non-zero exit code is not an error: the console already
            // showed it and waits on pause.
            c.status()
                .map_err(|e| format!("{}: {}", command_line, e))?;
            Ok(())
        }
        #[cfg(unix)]
        {
            let mut c = Command::new("sh");
            c.arg("-c").arg(&command_line);
            if let Some(dir) = &cwd {
                c.current_dir(dir);
            }
            c.status()
                .map_err(|e| format!("{}: {}", command_line, e))?;
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// True when the command line's first word is cmd's `start` (detached launch,
/// no pause wanted). Quotes, env prefixes and leading whitespace are ignored.
#[cfg(windows)]
fn starts_with_start(command_line: &str) -> bool {
    let line = command_line.trim().trim_start_matches('@');
    let line = line.trim_start_matches('"');
    line.split_whitespace()
        .next()
        .map(|w| w.trim_matches('"').eq_ignore_ascii_case("start"))
        .unwrap_or(false)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn merge_attrs_sets_and_clears_only_requested_bits() {
        const DIRECTORY: u32 = 0x10;
        // set R and A on a plain archive file
        assert_eq!(merge_attrs(0x20, Some(true), None, None, Some(true)), 0x21);
        // clear H, keep everything else (DIRECTORY must survive)
        assert_eq!(merge_attrs(DIRECTORY | 0x2 | 0x800, None, Some(false), None, None), DIRECTORY | 0x800);
        // all None = mask untouched, even a zero mask stays zero
        assert_eq!(merge_attrs(DIRECTORY, None, None, None, None), DIRECTORY);
        assert_eq!(merge_attrs(0, None, None, None, None), 0);
    }
}
