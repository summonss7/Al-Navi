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
pub fn drives_list() -> Vec<DriveDto> {
    let mut out: Vec<DriveDto> = Vec::new();

    #[cfg(windows)]
    {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        for d in disks.list() {
            let mp = d.mount_point().to_string_lossy().to_string();
            let letter = mp.trim_end_matches('\\').to_string();
            let label = d.name().to_string_lossy().to_string();
            let kind = if d.is_removable() {
                "removable"
            } else {
                match d.kind() {
                    sysinfo::DiskKind::SSD | sysinfo::DiskKind::HDD => "fixed",
                    _ => "unknown",
                }
            };
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
