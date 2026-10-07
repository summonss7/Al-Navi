use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

const CHUNK: usize = 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpProgress {
    pub id: u32,
    pub phase: String, // scan | transfer | delete | trash | done
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub files_total: u64,
    pub current: String,
    pub speed: u64, // bytes per second
    pub cancelled: bool,
    pub errors: Vec<OpError>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpError {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub id: u32,
    pub src: String,
    pub dst: String,
    pub is_dir: bool,
}

pub struct OpHandle {
    pub pause: Arc<AtomicBool>,
    pub cancel: Arc<AtomicBool>,
    pub conflict_tx: Mutex<Option<oneshot::Sender<String>>>,
}

struct OpManagerInner {
    next_id: AtomicU32,
    handles: Mutex<HashMap<u32, Arc<OpHandle>>>,
}

#[derive(Clone)]
pub struct OpManager {
    inner: Arc<OpManagerInner>,
}

impl OpManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(OpManagerInner {
                next_id: AtomicU32::new(1),
                handles: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn register(&self) -> (u32, Arc<OpHandle>) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let h = Arc::new(OpHandle {
            pause: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            conflict_tx: Mutex::new(None),
        });
        self.inner.handles.lock().unwrap().insert(id, h.clone());
        (id, h)
    }

    fn get(&self, id: u32) -> Option<Arc<OpHandle>> {
        self.inner.handles.lock().unwrap().get(&id).cloned()
    }

    pub(crate) fn finish(&self, id: u32) {
        self.inner.handles.lock().unwrap().remove(&id);
    }
}

impl Default for OpManager {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn op_control(state: tauri::State<'_, OpManager>, id: u32, action: String) -> Result<(), String> {
    let h = state.get(id).ok_or("no such operation")?;
    match action.as_str() {
        "pause" => h.pause.store(true, Ordering::Relaxed),
        "resume" => h.pause.store(false, Ordering::Relaxed),
        "cancel" => h.cancel.store(true, Ordering::Relaxed),
        _ => return Err(format!("unknown action: {}", action)),
    }
    Ok(())
}

#[tauri::command]
pub fn resolve_conflict(
    state: tauri::State<'_, OpManager>,
    id: u32,
    action: String,
) -> Result<(), String> {
    let h = state.get(id).ok_or("no such operation")?;
    let tx = h.conflict_tx.lock().unwrap().take();
    if let Some(tx) = tx {
        let _ = tx.send(action);
        Ok(())
    } else {
        Err("no pending conflict".into())
    }
}

#[tauri::command]
pub fn copy_paths(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    ftp: tauri::State<'_, crate::ftp::FtpState>,
    sftp: tauri::State<'_, crate::sftp::SftpState>,
    paths: Vec<String>,
    dest: String,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    if crate::remote_ops::involves_remote(&paths, &dest) {
        let (ftp, sftp) = (ftp.inner().clone(), sftp.inner().clone());
        tauri::async_runtime::spawn(async move {
            crate::remote_ops::run_transfer(app, mgr, id, h, ftp, sftp, paths, dest, false).await;
        });
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            run_transfer(app, mgr, id, h, paths, dest, false);
        });
    }
    Ok(id)
}

#[tauri::command]
pub fn move_paths(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    ftp: tauri::State<'_, crate::ftp::FtpState>,
    sftp: tauri::State<'_, crate::sftp::SftpState>,
    paths: Vec<String>,
    dest: String,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    if crate::remote_ops::involves_remote(&paths, &dest) {
        let (ftp, sftp) = (ftp.inner().clone(), sftp.inner().clone());
        tauri::async_runtime::spawn(async move {
            crate::remote_ops::run_transfer(app, mgr, id, h, ftp, sftp, paths, dest, true).await;
        });
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            run_transfer(app, mgr, id, h, paths, dest, true);
        });
    }
    Ok(id)
}

/// Split a user-entered transfer target into (destination directory, optional
/// new name for a single-item transfer). A trailing separator or an existing
/// directory keeps the "into that directory" behavior; otherwise the last
/// path component becomes the new name (FAR-style copy/move with rename).
pub(crate) fn resolve_dest(dest: &str, path_count: usize) -> (PathBuf, Option<String>) {
    let trimmed = dest.trim();
    let dest = PathBuf::from(trimmed);
    let ends_with_sep = trimmed.ends_with('/') || trimmed.ends_with('\\');
    if !ends_with_sep && !dest.is_dir() && path_count == 1 {
        if let Some(name) = dest.file_name() {
            let name = name.to_string_lossy().to_string();
            if !name.is_empty() {
                if let Some(parent) = dest.parent() {
                    if !parent.as_os_str().is_empty() {
                        return (parent.to_path_buf(), Some(name));
                    }
                }
            }
        }
    }
    (dest, None)
}

pub(crate) struct Ctx {
    pub(crate) app: AppHandle,
    pub(crate) id: u32,
    pub(crate) h: Arc<OpHandle>,
    pub(crate) bytes_done: u64,
    pub(crate) bytes_total: u64,
    pub(crate) files_done: u64,
    pub(crate) files_total: u64,
    pub(crate) speed: u64,
    last_emit: Instant,
    last_bytes: u64,
    last_speed_at: Instant,
    pub(crate) overwrite_all: bool,
    pub(crate) skip_all: bool,
    pub(crate) errors: Vec<OpError>,
    pub(crate) cancelled: bool,
}

impl Ctx {
    pub(crate) fn check_pause_cancel(&mut self) -> bool {
        if self.h.cancel.load(Ordering::Relaxed) {
            self.cancelled = true;
            return true;
        }
        while self.h.pause.load(Ordering::Relaxed) && !self.h.cancel.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(120));
        }
        if self.h.cancel.load(Ordering::Relaxed) {
            self.cancelled = true;
            return true;
        }
        false
    }

    pub(crate) fn progress(&mut self, phase: &str, current: &str) {
        let now = Instant::now();
        if now.duration_since(self.last_speed_at).as_millis() >= 500 {
            let db = self.bytes_done.saturating_sub(self.last_bytes);
            let dt = now.duration_since(self.last_speed_at).as_millis().max(1) as u64;
            self.speed = (db as u128 * 1000 / dt as u128) as u64;
            self.last_bytes = self.bytes_done;
            self.last_speed_at = now;
        }
        if now.duration_since(self.last_emit).as_millis() < 120 {
            return;
        }
        self.last_emit = now;
        let _ = self.app.emit(
            "op:progress",
            OpProgress {
                id: self.id,
                phase: phase.to_string(),
                bytes_done: self.bytes_done,
                bytes_total: self.bytes_total,
                files_done: self.files_done,
                files_total: self.files_total,
                current: current.to_string(),
                speed: self.speed,
                cancelled: false,
                errors: Vec::new(),
            },
        );
    }

    pub(crate) fn ask_conflict(&mut self, src: &Path, dst: &Path, is_dir: bool) -> String {
        if self.overwrite_all {
            return "overwrite".into();
        }
        if self.skip_all {
            return "skip".into();
        }
        let (tx, rx) = oneshot::channel::<String>();
        *self.h.conflict_tx.lock().unwrap() = Some(tx);
        let _ = self.app.emit(
            "op:conflict",
            ConflictInfo {
                id: self.id,
                src: src.to_string_lossy().to_string(),
                dst: dst.to_string_lossy().to_string(),
                is_dir,
            },
        );
        match rx.blocking_recv() {
            Ok(a) => match a.as_str() {
                "overwrite_all" => {
                    self.overwrite_all = true;
                    "overwrite".into()
                }
                "skip_all" => {
                    self.skip_all = true;
                    "skip".into()
                }
                other => other.to_string(),
            },
            Err(_) => "skip".into(),
        }
    }
}

/// "report.txt" -> "report (1).txt", bumping until free
pub(crate) fn auto_rename(dst: &Path) -> PathBuf {
    if !dst.exists() {
        return dst.to_path_buf();
    }
    let stem = dst
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = dst
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = dst.parent().unwrap_or(Path::new("."));
    for i in 1..u32::MAX {
        let cand = parent.join(format!("{} ({}){}", stem, i, ext));
        if !cand.exists() {
            return cand;
        }
    }
    dst.to_path_buf()
}

fn copy_file_c(src: &Path, dst: &Path, ctx: &mut Ctx) -> std::io::Result<()> {
    let mut inf = fs::File::open(src)?;
    let mut outf = fs::File::create(dst)?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if ctx.check_pause_cancel() {
            return Err(std::io::Error::other("cancelled"));
        }
        let n = inf.read(&mut buf)?;
        if n == 0 {
            break;
        }
        outf.write_all(&buf[..n])?;
        ctx.bytes_done += n as u64;
        ctx.progress("transfer", &src.to_string_lossy());
    }
    // preserve modification time (from the already-open handle, no extra stat)
    if let Ok(mtime) = inf.metadata().and_then(|m| m.modified()) {
        let ft = filetime::FileTime::from_system_time(mtime);
        let _ = filetime::set_file_times(dst, ft, ft);
    }
    Ok(())
}

pub(crate) fn ensure_writable(p: &Path) {
    if let Ok(meta) = fs::metadata(p) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(p, perms);
        }
    }
}

/// Copy one file honoring an already-resolved conflict decision.
fn copy_one_file_no_conflict(src: &Path, dst: &Path, ctx: &mut Ctx) -> std::io::Result<()> {
    ensure_writable(dst);
    copy_file_c(src, dst, ctx)?;
    ctx.files_done += 1;
    Ok(())
}

fn copy_one_file(src: &Path, dst: &Path, ctx: &mut Ctx) -> std::io::Result<()> {
    if dst.exists() {
        match ctx.ask_conflict(src, dst, false).as_str() {
            "skip" => {
                let sz = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
                ctx.bytes_done += sz;
                ctx.files_done += 1;
                return Ok(());
            }
            "rename" => {
                let alt = auto_rename(dst);
                copy_file_c(src, &alt, ctx)?;
                ctx.files_done += 1;
                return Ok(());
            }
            _ => {}
        }
    }
    copy_one_file_no_conflict(src, dst, ctx)
}

fn copy_dir_recursive(src: &Path, dst: &Path, ctx: &mut Ctx, move_mode: bool) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        if ctx.check_pause_cancel() {
            return Err(std::io::Error::other("cancelled"));
        }
        let entry = entry?;
        let sp = entry.path();
        let dp = dst.join(entry.file_name());
        if sp.is_dir() {
            copy_dir_recursive(&sp, &dp, ctx, move_mode)?;
        } else {
            copy_one_file(&sp, &dp, ctx)?;
        }
    }
    if move_mode {
        remove_tree(src)?;
    }
    Ok(())
}

/// Remove a directory tree even when entries are read-only — a plain
/// remove_dir_all fails on the first read-only file and used to leave a
/// fully copied source behind after cross-volume moves.
fn remove_tree(p: &Path) -> std::io::Result<()> {
    if !p.is_dir() {
        ensure_writable(p);
        return fs::remove_file(p);
    }
    for entry in fs::read_dir(p)? {
        remove_tree(&entry?.path())?;
    }
    ensure_writable(p);
    fs::remove_dir(p)
}

/// What to do with one source entry while merging a directory move.
#[derive(PartialEq, Eq, Debug)]
enum EntryPlan {
    /// destination is free — a single rename moves it instantly
    Rename,
    /// both sides are directories — merge them recursively
    MergeDirs,
    /// destination is taken by something else — copy flow (asks on conflict)
    CopyEntry,
}

fn plan_entry(src_entry: &Path, target: &Path) -> EntryPlan {
    if !target.exists() {
        EntryPlan::Rename
    } else if src_entry.is_dir() && target.is_dir() {
        EntryPlan::MergeDirs
    } else {
        EntryPlan::CopyEntry
    }
}

/// Move one file onto an existing target: honor the conflict answer, and
/// remove the source only when it was actually copied (skip keeps it).
fn move_one_file(src: &Path, dst: &Path, ctx: &mut Ctx) -> std::io::Result<()> {
    if dst.exists() {
        match ctx.ask_conflict(src, dst, false).as_str() {
            "skip" => {
                let sz = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
                ctx.bytes_done += sz;
                ctx.files_done += 1;
                return Ok(());
            }
            "rename" => {
                let alt = auto_rename(dst);
                copy_one_file_no_conflict(src, &alt, ctx)?;
                ensure_writable(src);
                fs::remove_file(src)?;
                return Ok(());
            }
            _ => {}
        }
    }
    copy_one_file_no_conflict(src, dst, ctx)?;
    ensure_writable(src);
    fs::remove_file(src)
}

/// Directory move with FAR-like speed: renaming is a metadata operation, so
/// entries with a free destination are renamed one by one; only genuinely
/// conflicting files go through the copy flow, and a failed rename (locked
/// entry, other volume) degrades to copying that single entry — never the
/// whole tree. The source dir is removed only if the merge emptied it.
fn move_dir_merge(src: &Path, dst: &Path, ctx: &mut Ctx) -> std::io::Result<()> {
    // free destination (e.g. after an auto-rename): one rename moves the
    // entire tree; on failure fall through to the per-entry merge below
    if !dst.exists() && rename_with_parent(src, dst) {
        let (bytes, files) = walk_stats(std::iter::once(dst));
        ctx.bytes_done += bytes;
        ctx.files_done += files;
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        if ctx.check_pause_cancel() {
            return Err(std::io::Error::other("cancelled"));
        }
        let entry = entry?;
        let sp = entry.path();
        let dp = dst.join(entry.file_name());
        ctx.progress("transfer", &sp.to_string_lossy());
        match plan_entry(&sp, &dp) {
            EntryPlan::Rename => {
                if rename_with_parent(&sp, &dp) {
                    let (bytes, files) = walk_stats(std::iter::once(dp.as_path()));
                    ctx.bytes_done += bytes;
                    ctx.files_done += files;
                } else if sp.is_dir() {
                    // locked or cross-volume: copy just this entry
                    copy_dir_recursive(&sp, &dp, ctx, true)?;
                } else {
                    copy_one_file_no_conflict(&sp, &dp, ctx)?;
                    ensure_writable(&sp);
                    fs::remove_file(&sp)?;
                }
            }
            EntryPlan::MergeDirs => {
                move_dir_merge(&sp, &dp, ctx)?;
            }
            EntryPlan::CopyEntry => {
                if sp.is_dir() {
                    copy_dir_recursive(&sp, &dp, ctx, true)?;
                } else {
                    move_one_file(&sp, &dp, ctx)?;
                }
            }
        }
    }
    // skipped entries stay in the source, like FAR
    let _ = fs::remove_dir(src);
    Ok(())
}

fn transfer_one(src: &Path, dst: &Path, ctx: &mut Ctx, move_mode: bool) -> std::io::Result<()> {
    let is_dir = src.is_dir();
    let mut dst = dst.to_path_buf();
    if dst.exists() {
        match ctx.ask_conflict(src, &dst, is_dir).as_str() {
            "skip" => {
                ctx.bytes_done += walk_size(src);
                return Ok(());
            }
            "rename" => dst = auto_rename(&dst),
            _ => {}
        }
    }
    if is_dir {
        // prevent copying a directory into itself
        let src_abs = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
        let dst_parent = dst.parent().unwrap_or(Path::new("."));
        let dst_abs = fs::canonicalize(dst_parent)
            .unwrap_or_else(|_| dst_parent.to_path_buf())
            .join(dst.file_name().unwrap_or_default());
        if dst_abs.starts_with(&src_abs) && dst_abs != src_abs {
            ctx.errors.push(OpError {
                path: dst.to_string_lossy().to_string(),
                error: "cannot copy a directory into itself".into(),
            });
            return Ok(());
        }
        if move_mode {
            move_dir_merge(src, &dst, ctx)?;
        } else {
            copy_dir_recursive(src, &dst, ctx, false)?;
        }
    } else if move_mode {
        match fs::rename(src, &dst) {
            Ok(()) => {
                let sz = fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
                ctx.bytes_done += sz;
                ctx.files_done += 1;
            }
            // cross-volume or locked: fall back to copy + delete
            Err(_) => {
                copy_one_file_no_conflict(src, &dst, ctx)?;
                ensure_writable(src);
                fs::remove_file(src)?;
            }
        }
    } else {
        copy_one_file(src, &dst, ctx)?;
    }
    Ok(())
}

pub(crate) fn walk_stats<'a>(paths: impl IntoIterator<Item = &'a Path>) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    for pb in paths {
        if pb.is_dir() {
            for e in walkdir::WalkDir::new(&pb).follow_links(false) {
                let Ok(e) = e else { continue };
                if e.file_type().is_file() {
                    bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                    files += 1;
                }
            }
        } else if let Ok(m) = fs::metadata(&pb) {
            bytes += m.len();
            files += 1;
        }
    }
    (bytes, files)
}

pub(crate) fn walk_size(p: &Path) -> u64 {
    if p.is_dir() {
        walkdir::WalkDir::new(p)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
            .sum()
    } else {
        fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    }
}

pub(crate) fn new_ctx(app: AppHandle, id: u32, h: Arc<OpHandle>) -> Ctx {
    Ctx {
        app,
        id,
        h,
        bytes_done: 0,
        bytes_total: 0,
        files_done: 0,
        files_total: 0,
        speed: 0,
        last_emit: Instant::now(),
        last_bytes: 0,
        last_speed_at: Instant::now(),
        overwrite_all: false,
        skip_all: false,
        errors: Vec::new(),
        cancelled: false,
    }
}

pub(crate) fn emit_done(ctx: &Ctx) {
    let _ = ctx.app.emit(
        "op:progress",
        OpProgress {
            id: ctx.id,
            phase: "done".into(),
            bytes_done: ctx.bytes_done,
            bytes_total: ctx.bytes_total,
            files_done: ctx.files_done,
            files_total: ctx.files_total,
            current: String::new(),
            speed: 0,
            cancelled: ctx.cancelled,
            errors: ctx.errors.clone(),
        },
    );
}

/// Rename, creating the destination parent first if needed (one retry).
fn rename_with_parent(src: &Path, dst: &Path) -> bool {
    if fs::rename(src, dst).is_ok() {
        return true;
    }
    if let Some(parent) = dst.parent() {
        if fs::create_dir_all(parent).is_ok() && fs::rename(src, dst).is_ok() {
            return true;
        }
    }
    false
}

/// Windows paths are case-insensitive: D:\A and d:\a are the same
/// directory, so a plain PathBuf comparison misses self-targets.
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    #[cfg(windows)]
    {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn run_transfer(
    app: AppHandle,
    mgr: OpManager,
    id: u32,
    h: Arc<OpHandle>,
    paths: Vec<String>,
    dest: String,
    move_mode: bool,
) {
    let mut ctx = new_ctx(app, id, h);

    let (dest, single_name) = resolve_dest(&dest, paths.len());
    // (src, dst) pairs; a target resolved back to the source (both panels in
    // one dir) — copying or moving an item onto itself is a no-op, not a conflict
    let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    for p in &paths {
        let src = PathBuf::from(p);
        let dstd = match &single_name {
            Some(name) => dest.join(name),
            None => dest.join(src.file_name().unwrap_or_default()),
        };
        if !same_path(&dstd, &src) {
            pairs.push((src, dstd));
        }
    }

    // Phase A — instant same-volume renames (move only): a same-volume move
    // is a metadata operation no matter how many files the tree holds, so
    // try fs::rename before any scanning or copying. Items whose destination
    // exists (conflict flow) or which live on another volume fall through to
    // the full transfer below.
    if move_mode {
        let mut rest: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut renamed: u64 = 0;
        for (src, dstd) in pairs {
            if ctx.check_pause_cancel() || dstd.exists() {
                rest.push((src, dstd));
                continue;
            }
            if rename_with_parent(&src, &dstd) {
                renamed += 1;
                ctx.progress("transfer", &src.to_string_lossy());
            } else {
                rest.push((src, dstd));
            }
        }
        if rest.is_empty() || ctx.cancelled {
            // counters reflect top-level items when no copying happened
            ctx.files_done = renamed;
            ctx.files_total = renamed + rest.len() as u64;
            emit_done(&ctx);
            mgr.finish(id);
            return;
        }
        pairs = rest;
    }

    // Phase B — full transfer with prescan (copies, cross-volume moves,
    // conflicts with an existing destination: dir moves merge per entry —
    // renames where possible, copies only what really conflicts)
    ctx.progress("scan", "");
    let (bytes, files) = walk_stats(pairs.iter().map(|(s, _)| s.as_path()));
    ctx.bytes_total = bytes;
    ctx.files_total = files;

    for (src, dstd) in &pairs {
        if ctx.check_pause_cancel() {
            break;
        }
        ctx.progress("transfer", &src.to_string_lossy());
        if let Err(e) = transfer_one(src, dstd, &mut ctx, move_mode) {
            if e.to_string() == "cancelled" {
                ctx.cancelled = true;
                break;
            }
            ctx.errors.push(OpError {
                path: src.to_string_lossy().to_string(),
                error: e.to_string(),
            });
        }
    }
    emit_done(&ctx);
    mgr.finish(id);
}

#[tauri::command]
pub fn delete_paths(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    ftp: tauri::State<'_, crate::ftp::FtpState>,
    sftp: tauri::State<'_, crate::sftp::SftpState>,
    paths: Vec<String>,
    permanent: bool,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    // there is no trash on a server — remote deletes are always direct
    if paths.iter().any(|p| crate::remote_ops::is_remote_str(p)) {
        let (ftp, sftp) = (ftp.inner().clone(), sftp.inner().clone());
        tauri::async_runtime::spawn(async move {
            crate::remote_ops::run_delete(app, mgr, id, h, ftp, sftp, paths).await;
        });
        return Ok(id);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut ctx = new_ctx(app.clone(), id, h);
        // no recursive pre-walk: the delete itself walks the tree, so a
        // pre-scan only doubled the cost on large directories — progress is
        // counted per selected path (bytes stay 0, the UI falls back to counts)
        ctx.files_total = paths.len() as u64;
        for (i, p) in paths.iter().enumerate() {
            if ctx.check_pause_cancel() {
                break;
            }
            let pb = PathBuf::from(p);
            ctx.progress(if permanent { "delete" } else { "trash" }, p);
            let res = if permanent {
                if pb.is_dir() {
                    fs::remove_dir_all(&pb).map_err(|e| e.to_string())
                } else {
                    ensure_writable(&pb);
                    fs::remove_file(&pb).map_err(|e| e.to_string())
                }
            } else {
                trash::delete(&pb).map_err(|e| e.to_string())
            };
            if let Err(err) = res {
                ctx.errors.push(OpError {
                    path: p.clone(),
                    // alnavi-003: lock errors name the holding process
                    error: crate::locks::describe_delete_error(&pb, err),
                });
            }
            ctx.files_done = (i + 1) as u64;
        }
        emit_done(&ctx);
        mgr.finish(id);
    });
    Ok(id)
}

#[derive(Deserialize)]
pub struct RenamePair {
    pub old: String,
    pub new: String,
}

/// Ctrl+M multi-rename: one queued op for a batch of old->new pairs, counted
/// per item (bytes stay 0, the UI falls back to counts). An occupied target
/// or an IO failure fails that pair only — the rest of the batch continues
/// and everything lands in the op's error list.
#[tauri::command]
pub fn rename_paths(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    pairs: Vec<RenamePair>,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ctx = new_ctx(app.clone(), id, h);
        ctx.files_total = pairs.len() as u64;
        for (i, pair) in pairs.iter().enumerate() {
            if ctx.check_pause_cancel() {
                break;
            }
            let (from, to) = (PathBuf::from(&pair.old), PathBuf::from(&pair.new));
            ctx.progress("transfer", &pair.new);
            // a Windows path compares equal to its own case-change — that
            // rename must still run, it just must not count as a conflict
            let case_only = from != to && same_path(&from, &to);
            if from == to {
                // nothing to do
            } else if to.exists() && !case_only {
                ctx.errors.push(OpError {
                    path: pair.old.clone(),
                    error: format!("already exists: {}", pair.new),
                });
            } else if !rename_with_parent(&from, &to) {
                ctx.errors.push(OpError {
                    path: pair.old.clone(),
                    error: format!("{} -> {}: rename failed", pair.old, pair.new),
                });
            }
            ctx.files_done = (i + 1) as u64;
        }
        emit_done(&ctx);
        mgr.finish(id);
    });
    Ok(id)
}

#[tauri::command]
pub fn rename_path(old: String, new: String) -> Result<(), String> {
    let (from, to) = (PathBuf::from(&old), PathBuf::from(&new));
    if from == to {
        return Ok(());
    }
    if to.exists() {
        return Err(format!("already exists: {}", new));
    }
    fs::rename(&from, &to).map_err(|e| format!("{} -> {}: {}", old, new, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_dest_directory_forms() {
        let tmp = std::env::temp_dir().join("alnavi_resolve_dest_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("dir")).unwrap();

        // trailing separator -> always the "into the directory" form
        let (d, n) = resolve_dest("C:\\some\\dir\\", 1);
        assert!(n.is_none());
        assert_eq!(d, PathBuf::from("C:\\some\\dir\\"));

        // an existing directory keeps it a directory even for a single item
        let (d, n) = resolve_dest(tmp.join("dir").to_str().unwrap(), 1);
        assert!(n.is_none());
        assert_eq!(d, tmp.join("dir"));

        // single item + non-existing target -> dir + new name (rename)
        let (d, n) = resolve_dest("C:\\some\\newname.txt", 1);
        assert_eq!(d, PathBuf::from("C:\\some"));
        assert_eq!(n.as_deref(), Some("newname.txt"));

        // multiple items are never renamed to one name
        let (_, n) = resolve_dest("C:\\some\\newname.txt", 3);
        assert!(n.is_none());

        // a root path has no file_name — stays whole
        let (d, n) = resolve_dest("C:\\", 1);
        assert!(n.is_none());
        assert_eq!(d, PathBuf::from("C:\\"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
