//! alnavi-003: name the process that keeps a failed delete alive. The raw
//! error only says "os error 32/5"; the question is always "who holds it?".
//! Files go through the Restart Manager (the API behind Windows' own
//! "file in use" dialog). It cannot register directories, so for those we
//! scan every process's current directory (sysinfo) — a process sitting in
//! a folder is the usual reason a folder refuses to die — and, if that
//! finds nothing, batch-query the files a partial delete left behind.

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use walkdir::WalkDir;

    const ERROR_MORE_DATA: u32 = 234;
    const CCH_RM_SESSION_KEY: usize = 32;
    const CCH_RM_MAX_APP_NAME: usize = 255;
    const CCH_RM_MAX_SVC_NAME: usize = 63;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FileTime {
        lo: u32,
        hi: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RmUniqueProcess {
        pid: u32,
        start: FileTime,
    }

    /// Must match RM_PROCESS_INFO from restartmanager.h exactly (including
    /// TSSessionId): a short struct makes RmGetList write past the buffer.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RmProcessInfo {
        process: RmUniqueProcess,
        app_name: [u16; CCH_RM_MAX_APP_NAME + 1],
        service_name: [u16; CCH_RM_MAX_SVC_NAME + 1],
        app_type: u32,
        app_status: u32,
        ts_session_id: u32,
        restartable: i32,
    }

    #[link(name = "rstrtmgr")]
    extern "system" {
        fn RmStartSession(session: *mut u32, flags: u32, key: *mut u16) -> u32;
        fn RmRegisterResources(
            session: u32,
            n_files: u32,
            files: *const *const u16,
            n_apps: u32,
            apps: *const RmUniqueProcess,
            n_services: u32,
            services: *const *const u16,
        ) -> u32;
        fn RmGetList(
            session: u32,
            needed: *mut u32,
            count: *mut u32,
            infos: *mut RmProcessInfo,
            reboot_reasons: *mut u32,
        ) -> u32;
        fn RmEndSession(session: u32) -> u32;
    }

    fn wide(p: &Path) -> Vec<u16> {
        OsStr::new(p).encode_wide().chain(Some(0)).collect()
    }

    fn wstr(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    /// Processes holding any of `paths` open, per the Restart Manager. One
    /// session covers the whole batch, so a directory sweep costs a single
    /// round trip. Errors are swallowed on purpose: this is a best-effort
    /// addendum to a delete error, never worth failing over.
    fn rm_holders(paths: &[PathBuf]) -> Vec<(u32, String)> {
        if paths.is_empty() {
            return Vec::new();
        }
        let mut session: u32 = 0;
        let mut key = [0u16; CCH_RM_SESSION_KEY + 1];
        let rc = unsafe { RmStartSession(&mut session, 0, key.as_mut_ptr()) };
        if rc != 0 {
            return Vec::new();
        }
        let wide_paths: Vec<Vec<u16>> = paths.iter().map(|p| wide(p)).collect();
        let ptrs: Vec<*const u16> = wide_paths.iter().map(|w| w.as_ptr()).collect();
        let mut out = Vec::new();
        if unsafe {
            RmRegisterResources(
                session,
                ptrs.len() as u32,
                ptrs.as_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
            )
        } == 0
        {
            let mut needed: u32 = 0;
            let mut count: u32 = 0;
            let mut reboot: u32 = 0;
            // first call sizes the list: ERROR_MORE_DATA is the expected rc
            let rc = unsafe {
                RmGetList(session, &mut needed, &mut count, std::ptr::null_mut(), &mut reboot)
            };
            if rc == ERROR_MORE_DATA && needed > 0 {
                let mut infos = vec![unsafe { std::mem::zeroed::<RmProcessInfo>() }; needed as usize];
                count = needed;
                if unsafe {
                    RmGetList(session, &mut needed, &mut count, infos.as_mut_ptr(), &mut reboot)
                } == 0
                {
                    for info in &infos[..count.min(infos.len() as u32) as usize] {
                        let mut name = wstr(&info.app_name);
                        if name.is_empty() {
                            name = wstr(&info.service_name);
                        }
                        if name.is_empty() {
                            name = format!("pid {}", info.process.pid);
                        }
                        out.push((info.process.pid, format!("{name} (pid {})", info.process.pid)));
                    }
                }
            }
        }
        unsafe { RmEndSession(session) };
        out
    }

    /// Processes whose current directory is `dir` or inside it — the classic
    /// reason a "used by another process" folder delete fails.
    fn cwd_holders(dir: &Path) -> Vec<(u32, String)> {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
        );
        let target = dir.to_string_lossy().to_lowercase();
        let target = target.trim_end_matches('\\');
        let prefix = format!("{target}\\");
        let mut out = Vec::new();
        for (_, proc) in sys.processes() {
            let Some(cwd) = proc.cwd() else { continue };
            let cwd = cwd.to_string_lossy().to_lowercase();
            let cwd = cwd.trim_end_matches('\\');
            if cwd == target || cwd.starts_with(&prefix) {
                out.push((
                    proc.pid().as_u32(),
                    format!(
                        "{} (pid {}, working directory)",
                        proc.name().to_string_lossy(),
                        proc.pid().as_u32()
                    ),
                ));
            }
        }
        out
    }

    /// Files a failed recursive delete left under `dir` (everything deletable
    /// is gone, so what remains includes the locked one). Capped: the RM
    /// batch query takes them all in one session anyway, the cap only bounds
    /// memory for the pathological case.
    fn remaining_files(dir: &Path) -> Vec<PathBuf> {
        const CAP: usize = 500;
        let mut out = Vec::new();
        for entry in WalkDir::new(dir).into_iter().flatten() {
            if entry.file_type().is_file() {
                out.push(entry.into_path());
                if out.len() >= CAP {
                    break;
                }
            }
        }
        out
    }

    /// Lock-shaped delete errors worth a holder lookup. std fs prints
    /// "(os error 32/5)"; the trash crate wraps HRESULTs (0x80070020/05) or
    /// aborts IFileOperation with a generic message ("Some operations were
    /// aborted" / CouldNotAccess) when an item refuses to move. Lookups that
    /// find nobody leave the error untouched, so a generous matcher is safe.
    fn is_lock_error(err: &str) -> bool {
        let e = err.to_ascii_lowercase();
        e.contains("(os error 32)")
            || e.contains("(os error 5)")
            || e.contains("0x80070020")
            || e.contains("0x80070005")
            || e.contains("operations were aborted")
            || e.contains("couldnotaccess")
    }

    fn format_holders(err: String, holders: Vec<(u32, String)>) -> String {
        if holders.is_empty() {
            return err;
        }
        let mut holders = holders;
        holders.sort_by_key(|(pid, _)| *pid);
        holders.dedup_by(|a, b| a.0 == b.0);
        let shown = holders.len().min(6);
        let mut names: Vec<String> = holders[..shown].iter().map(|(_, s)| s.clone()).collect();
        if holders.len() > shown {
            names.push(format!("+{} more", holders.len() - shown));
        }
        format!("{err}; held by: {}", names.join(", "))
    }

    /// The error of a failed delete, with "; held by: ..." appended when the
    /// holding process could be named. Comes back untouched for non-lock
    /// errors and when the lookup finds nobody.
    pub fn describe_delete_error(path: &Path, err: String) -> String {
        if !is_lock_error(&err) {
            return err;
        }
        let holders = match fs::metadata(path) {
            Ok(m) if m.is_file() => rm_holders(&[path.to_path_buf()]),
            Ok(m) if m.is_dir() => {
                let mut holders = cwd_holders(path);
                if holders.is_empty() {
                    holders = rm_holders(&remaining_files(path));
                }
                holders
            }
            // gone between the delete and the lookup — nothing to ask about
            _ => Vec::new(),
        };
        format_holders(err, holders)
    }
}

#[cfg(windows)]
pub use imp::describe_delete_error;

#[cfg(not(windows))]
/// No Restart Manager off Windows: the error string passes through as is.
pub fn describe_delete_error(_path: &std::path::Path, err: String) -> String {
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_errors_are_recognized_in_both_shapes() {
        assert!(imp::is_lock_error(
            "The process cannot access the file because it is being used by another process. (os error 32)"
        ));
        assert!(imp::is_lock_error("Access is denied. (os error 5)"));
        assert!(imp::is_lock_error("windows error: ... (0x80070020)"));
        assert!(imp::is_lock_error("windows error: ... (0x80070005)"));
        assert!(imp::is_lock_error(
            "Error during a `trash` operation: Unknown { description: \"Some operations were aborted\" }"
        ));
        assert!(imp::is_lock_error(
            "Error during a `trash` operation: CouldNotAccess { target: \"C:\\\\x\" }"
        ));
        assert!(!imp::is_lock_error("Access is denied. (os error 52)"));
        assert!(!imp::is_lock_error("The system cannot find the path specified. (os error 3)"));
        assert!(!imp::is_lock_error("already exists"));
    }

    #[test]
    fn holders_are_deduped_by_pid_and_capped() {
        let err = String::from("denied");
        let one = imp::format_holders(err.clone(), vec![(9, "b (pid 9)".into())]);
        assert_eq!(one, "denied; held by: b (pid 9)");
        // same pid twice (several held files) collapses to one entry
        let dup = imp::format_holders(err.clone(), vec![
            (9, "b (pid 9)".into()),
            (9, "b (pid 9)".into()),
        ]);
        assert_eq!(dup, "denied; held by: b (pid 9)");
        let mut many = (0..9).map(|i| (i, format!("p{i} (pid {i})"))).collect();
        let capped = imp::format_holders(err.clone(), std::mem::take(&mut many));
        assert!(capped.ends_with("+3 more)"));
        assert!(capped.matches("(pid").count() == 6);
        assert_eq!(imp::format_holders(err.clone(), vec![]), "denied");
    }
}
