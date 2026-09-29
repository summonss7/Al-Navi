use serde::Serialize;
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

    fn register(&self) -> (u32, Arc<OpHandle>) {
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

    fn finish(&self, id: u32) {
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
    paths: Vec<String>,
    dest_dir: String,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_transfer(app, mgr, id, h, paths, dest_dir, false);
    });
    Ok(id)
}

#[tauri::command]
pub fn move_paths(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    paths: Vec<String>,
    dest_dir: String,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_transfer(app, mgr, id, h, paths, dest_dir, true);
    });
    Ok(id)
}

struct Ctx {
    app: AppHandle,
    id: u32,
    h: Arc<OpHandle>,
    bytes_done: u64,
    bytes_total: u64,
    files_done: u64,
    files_total: u64,
    speed: u64,
    last_emit: Instant,
    last_bytes: u64,
    last_speed_at: Instant,
    overwrite_all: bool,
    skip_all: bool,
    errors: Vec<OpError>,
    cancelled: bool,
}

impl Ctx {
    fn check_pause_cancel(&mut self) -> bool {
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

    fn progress(&mut self, phase: &str, current: &str) {
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

    fn ask_conflict(&mut self, src: &Path, dst: &Path, is_dir: bool) -> String {
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
fn auto_rename(dst: &Path) -> PathBuf {
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
    // preserve modification time
    if let Ok(meta) = fs::metadata(src) {
        if let Ok(mtime) = meta.modified() {
            let ft = filetime::FileTime::from_system_time(mtime);
            let _ = filetime::set_file_times(dst, ft, ft);
        }
    }
    Ok(())
}

fn ensure_writable(p: &Path) {
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
        fs::remove_dir_all(src)?;
    }
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
        copy_dir_recursive(src, &dst, ctx, move_mode)?;
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

fn walk_stats(paths: &[String]) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    for p in paths {
        let pb = PathBuf::from(p);
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

fn walk_size(p: &Path) -> u64 {
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

fn new_ctx(app: AppHandle, id: u32, h: Arc<OpHandle>) -> Ctx {
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

fn emit_done(ctx: &Ctx) {
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

fn run_transfer(
    app: AppHandle,
    mgr: OpManager,
    id: u32,
    h: Arc<OpHandle>,
    paths: Vec<String>,
    dest_dir: String,
    move_mode: bool,
) {
    let mut ctx = new_ctx(app, id, h);

    ctx.progress("scan", "");
    let (bytes, files) = walk_stats(&paths);
    ctx.bytes_total = bytes;
    ctx.files_total = files;
    if ctx.cancelled {
        emit_done(&ctx);
        mgr.finish(id);
        return;
    }

    let dest = PathBuf::from(&dest_dir);
    for p in &paths {
        if ctx.check_pause_cancel() {
            break;
        }
        let src = PathBuf::from(p);
        let dstd = dest.join(src.file_name().unwrap_or_default());
        ctx.progress("transfer", &src.to_string_lossy());
        if let Err(e) = transfer_one(&src, &dstd, &mut ctx, move_mode) {
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
    paths: Vec<String>,
    permanent: bool,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ctx = new_ctx(app.clone(), id, h);
        ctx.bytes_total = paths.iter().map(|p| walk_size(Path::new(p))).sum();
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
                    error: err,
                });
            }
            ctx.files_done = (i + 1) as u64;
            ctx.bytes_done = ctx.bytes_total * ctx.files_done / ctx.files_total.max(1);
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
