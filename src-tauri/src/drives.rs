use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveDto {
    pub name: String,      // display name, e.g. "System (C:)" or "/"
    pub mount_point: String,
    pub kind: String,      // fixed | removable | cd | network | ram | home | root
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[tauri::command]
pub async fn drives_list() -> Result<Vec<DriveDto>, String> {
    // volume enumeration can stall on stale network drives — keep it off the
    // IPC thread
    tauri::async_runtime::spawn_blocking(drives_list_blocking)
        .await
        .map_err(|e| e.to_string())
}

fn kind_of(d: &sysinfo::Disk) -> &'static str {
    if d.is_removable() {
        "removable"
    } else {
        match d.kind() {
            sysinfo::DiskKind::SSD | sysinfo::DiskKind::HDD => "fixed",
            _ => "unknown",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDto {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeDto {
    pub label: String, // "" when no local disk matches (e.g. remote panel)
    pub mount_point: String,
    pub kind: String,
    pub file_system: String, // NTFS, ext4 ...
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
    pub memory: MemoryDto,
}

/// Ctrl+L info dialog: the volume holding `path` (longest mount-point
/// prefix match) plus machine-wide RAM/swap — FAR-style drive info.
#[tauri::command]
pub async fn drive_info(path: String) -> Result<VolumeDto, String> {
    tauri::async_runtime::spawn_blocking(move || volume_of(&path))
        .await
        .map_err(|e| e.to_string())
}

fn volume_of(path: &str) -> VolumeDto {
    use sysinfo::Disks;

    let mut vol = VolumeDto {
        label: String::new(),
        mount_point: String::new(),
        kind: String::new(),
        file_system: String::new(),
        total_bytes: 0,
        free_bytes: 0,
        used_bytes: 0,
        memory: memory_of(),
    };
    let p = std::path::Path::new(path);
    let disks = Disks::new_with_refreshed_list();
    let mut best_len = 0usize;
    for d in disks.list() {
        let mp = d.mount_point();
        if p.starts_with(mp) && mp.as_os_str().len() > best_len {
            best_len = mp.as_os_str().len();
            let total = d.total_space();
            let free = d.available_space();
            vol = VolumeDto {
                label: d.name().to_string_lossy().to_string(),
                mount_point: mp.to_string_lossy().to_string(),
                kind: kind_of(d).to_string(),
                file_system: d.file_system().to_string_lossy().to_string(),
                total_bytes: total,
                free_bytes: free,
                used_bytes: total.saturating_sub(free),
                memory: vol.memory,
            };
        }
    }
    vol
}

fn memory_of() -> MemoryDto {
    use sysinfo::System;
    let sys = System::new_all();
    MemoryDto {
        total_bytes: sys.total_memory(),
        used_bytes: sys.used_memory(),
        free_bytes: sys.available_memory(),
        swap_total_bytes: sys.total_swap(),
        swap_used_bytes: sys.used_swap(),
    }
}

fn drives_list_blocking() -> Vec<DriveDto> {
    let mut out: Vec<DriveDto> = Vec::new();

    #[cfg(windows)]
    {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        for d in disks.list() {
            let mp = d.mount_point().to_string_lossy().to_string();
            let letter = mp.trim_end_matches('\\').to_string();
            let label = d.name().to_string_lossy().to_string();
            let kind = kind_of(d);
            let name = if label.is_empty() {
                letter.clone()
            } else {
                format!("{} ({})", label, letter)
            };
            out.push(DriveDto {
                name,
                mount_point: mp,
                kind: kind.to_string(),
                total_bytes: d.total_space(),
                free_bytes: d.available_space(),
            });
        }
    }

    #[cfg(unix)]
    {
        use sysinfo::Disks;
        // fixed entries first: root + home
        let home = dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|| "/home".into());
        out.push(DriveDto {
            name: "Root".into(),
            mount_point: "/".into(),
            kind: "root".into(),
            total_bytes: 0,
            free_bytes: 0,
        });
        out.push(DriveDto {
            name: "Home".into(),
            mount_point: home,
            kind: "home".into(),
            total_bytes: 0,
            free_bytes: 0,
        });
        let disks = Disks::new_with_refreshed_list();
        for d in disks.list() {
            let mp = d.mount_point().to_string_lossy().to_string();
            if mp == "/" {
                if let Some(root) = out.first_mut() {
                    root.total_bytes = d.total_space();
                    root.free_bytes = d.available_space();
                }
                continue;
            }
            let kind = match d.kind() {
                sysinfo::DiskKind::SSD | sysinfo::DiskKind::HDD => {
                    if d.is_removable() {
                        "removable"
                    } else {
                        "fixed"
                    }
                }
            };
            out.push(DriveDto {
                name: mp.clone(),
                mount_point: mp,
                kind: kind.to_string(),
                total_bytes: d.total_space(),
                free_bytes: d.available_space(),
            });
        }
        // fill home free/total from the disk that mounts it
        let disks = Disks::new_with_refreshed_list();
        let home_mp = out
            .iter()
            .find(|d| d.kind == "home")
            .map(|d| d.mount_point.clone())
            .unwrap_or_default();
        for d in disks.list() {
            if std::path::Path::new(&home_mp).starts_with(d.mount_point()) {
                if let Some(h) = out.iter_mut().find(|x| x.kind == "home") {
                    h.total_bytes = d.total_space();
                    h.free_bytes = d.available_space();
                }
                break;
            }
        }
    }

    out
}
