// FTP file operations on the same op queue as the local engine (ops.rs):
// identical op ids, "op:progress" / "op:conflict" events and the same
// pause/cancel/resolve_conflict controls, so the progress and conflict
// dialogs work unchanged.
//
// Transfers run on dedicated control connections cloned from the live
// session credentials — a single control connection cannot carry a data
// transfer and panel LIST/CWD traffic at the same time, and this way panel
// navigation keeps working while files move. A connection that dies mid-op
// is dropped and the next file reconnects; a file interrupted by that is
// restarted once on the fresh connection.
//
// Directions: disk -> FTP (MKD + STOR), FTP -> disk (RETR), FTP -> FTP
// (streamed through a temp file — the protocol has no server-to-server
// copy). A move between two folders of one server is the RNFR/RNTO fast
// path with no copying at all; every other move is a copy followed by a
// recursive delete of the source (entries the user skipped stay, like FAR).
use crate::fs::EntryDto;
use crate::ftp::{connect_session, list_remote, parse_ftp_path, split_remote, FtpSession, FtpState};
use crate::ops::{
    auto_rename, emit_done, ensure_writable, new_ctx, same_path, walk_size, walk_stats, ConflictInfo, Ctx,
    OpError, OpHandle, OpManager,
};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use suppaftp::FtpError;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use walkdir::WalkDir;

const CHUNK: usize = 64 * 1024;
/// control commands (cwd/mkd/list/rm/…) must answer within this
const CTRL_TIMEOUT: Duration = Duration::from_secs(60);
/// a data connection may go this long without a byte before giving up
const DATA_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn involves_ftp(paths: &[String], dest: &str) -> bool {
    dest.starts_with("ftp://") || paths.iter().any(|p| p.starts_with("ftp://"))
}

/// How a file operation failed. Conn errors take the control session down
/// with them (it may hold a half-finished reply); Msg errors leave it alone.
#[derive(Debug, Clone, PartialEq)]
enum OpErr {
    Cancelled,
    Conn(String),
    Msg(String),
}

impl OpErr {
    fn msg(&self) -> String {
        match self {
            OpErr::Cancelled => "cancelled".to_string(),
            OpErr::Conn(s) | OpErr::Msg(s) => s.clone(),
        }
    }
}

fn map_ftp_err(e: FtpError) -> OpErr {
    match e {
        FtpError::ConnectionError(_) => OpErr::Conn(format!("FTP: {e}")),
        _ => OpErr::Msg(format!("FTP: {e}")),
    }
}

/// run a control command with a timeout
async fn ctrl<T, F>(f: F) -> Result<T, OpErr>
where
    F: Future<Output = suppaftp::FtpResult<T>> + Send,
    T: Send,
{
    tokio::time::timeout(CTRL_TIMEOUT, f)
        .await
        .map_err(|_| OpErr::Conn("FTP: control command timeout".into()))?
        .map_err(map_ftp_err)
}

// ---- async twin of ops::Ctx: same counters and event contract, but pause
// parks in tokio::time::sleep and conflict answers arrive over an await ----
struct ACtx {
    inner: Ctx,
}

impl ACtx {
    fn new(app: AppHandle, id: u32, h: Arc<OpHandle>) -> Self {
        ACtx { inner: new_ctx(app, id, h) }
    }

    async fn check_pause_cancel(&mut self) -> bool {
        if self.inner.h.cancel.load(Ordering::Relaxed) {
            self.inner.cancelled = true;
            return true;
        }
        while self.inner.h.pause.load(Ordering::Relaxed) && !self.inner.h.cancel.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        if self.inner.h.cancel.load(Ordering::Relaxed) {
            self.inner.cancelled = true;
            return true;
        }
        false
    }

    fn progress(&mut self, phase: &str, current: &str) {
        self.inner.progress(phase, current);
    }

    async fn ask_conflict(&mut self, src: &str, dst: &str, is_dir: bool) -> String {
        if self.inner.overwrite_all {
            return "overwrite".into();
        }
        if self.inner.skip_all {
            return "skip".into();
        }
        let (tx, rx) = oneshot::channel::<String>();
        *self.inner.h.conflict_tx.lock().unwrap() = Some(tx);
        let _ = self.inner.app.emit(
            "op:conflict",
            ConflictInfo {
                id: self.inner.id,
                src: src.to_string(),
                dst: dst.to_string(),
                is_dir,
            },
        );
        match rx.await {
            Ok(a) => match a.as_str() {
                "overwrite_all" => {
                    self.inner.overwrite_all = true;
                    "overwrite".into()
                }
                "skip_all" => {
                    self.inner.skip_all = true;
                    "skip".into()
                }
                other => other.to_string(),
            },
            Err(_) => "skip".into(),
        }
    }
}

// ---- dedicated connections + remote listings for one operation ----

struct OpEnv {
    id: u32,
    state: FtpState,
    sess: HashMap<String, FtpSession>,
    /// directory listings reused by conflict checks; entries created by this
    /// very op never collide with names already in the listing
    cache: HashMap<(String, String), Vec<EntryDto>>,
    temp_seq: u64,
}

impl OpEnv {
    fn new(id: u32, state: FtpState) -> Self {
        OpEnv { id, state, sess: HashMap::new(), cache: HashMap::new(), temp_seq: 0 }
    }

    async fn conn(&mut self, key: &str) -> Result<&mut FtpSession, OpErr> {
        if !self.sess.contains_key(key) {
            let creds = self.state.creds_for(key).await.ok_or_else(|| {
                OpErr::Msg(format!("FTP: not connected — open ftp://{key} in a panel first"))
            })?;
            let s = connect_session(&creds).await.map_err(OpErr::Msg)?;
            self.sess.insert(key.to_string(), s);
        }
        Ok(self.sess.get_mut(key).unwrap())
    }

    fn drop_conn(&mut self, key: &str) {
        self.sess.remove(key);
    }

    async fn close(&mut self) {
        for (_, mut s) in self.sess.drain() {
            let _ = s.stream.quit().await;
        }
    }

    async fn listing(&mut self, key: &str, dir: &str) -> Result<Vec<EntryDto>, OpErr> {
        if let Some(v) = self.cache.get(&(key.to_string(), dir.to_string())) {
            return Ok(v.clone());
        }
        let s = self.conn(key).await?;
        let v = ctrl(list_remote(s, dir)).await?;
        self.cache.insert((key.to_string(), dir.to_string()), v.clone());
        Ok(v)
    }

    fn temp_path(&mut self) -> PathBuf {
        self.temp_seq += 1;
        std::env::temp_dir().join(format!("al-navi-ftp-{}-{}", self.id, self.temp_seq))
    }
}

// ---- remote path helpers ----

fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{}{}", dir, name)
    } else {
        format!("{}/{}", dir, name)
    }
}

/// "ftp://u@h:1/a/b" -> "ftp://u@h:1" (the part before the first path slash)
fn authority_of(p: &str) -> &str {
    let rest = &p[6..]; // skip "ftp://"
    match rest.find('/') {
        Some(i) => &p[..6 + i],
        None => p,
    }
}

fn base_name(p: &str) -> String {
    if p.starts_with("ftp://") {
        p.rsplit('/').next().unwrap_or("").to_string()
    } else {
        Path::new(p)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    }
}

/// self-target check (copying an item onto itself is a no-op, not a conflict)
fn same_item(a: &str, b: &str) -> bool {
    let a_ftp = a.starts_with("ftp://");
    let b_ftp = b.starts_with("ftp://");
    if a_ftp != b_ftp {
        return false;
    }
    if a_ftp {
        a.eq_ignore_ascii_case(b)
    } else {
        same_path(Path::new(a), Path::new(b))
    }
}

/// remote path relative to a walked root, without the leading slash
fn rel_of(path: &str, root: &str) -> String {
    path.strip_prefix(root).unwrap_or(path).trim_start_matches('/').to_string()
}

/// stat a remote path through the (cached) listing of its parent
async fn remote_stat(env: &mut OpEnv, key: &str, rpath: &str) -> Result<Option<EntryDto>, OpErr> {
    let (parent, name) = split_remote(rpath);
    Ok(env.listing(key, &parent).await?.into_iter().find(|e| e.name == name))
}

/// "name (3)" -> Some((5, 3)): position of the "(3)" part and its number
fn stem_index(stem: &str) -> Option<(usize, u32)> {
    if !stem.ends_with(')') {
        return None;
    }
    let open = stem.rfind(" (")?;
    let num: u32 = stem[open + 2..stem.len() - 1].parse().ok()?;
    Some((open + 1, num))
}

/// "name.ext" -> "name (N).ext", first free N — mirror of ops::auto_rename
/// for remote targets (existence probed through the parent listing)
async fn auto_rename_remote(env: &mut OpEnv, key: &str, rpath: &str) -> Result<String, OpErr> {
    if remote_stat(env, key, rpath).await?.is_none() {
        return Ok(rpath.to_string());
    }
    let (parent, name) = split_remote(rpath);
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    let mut n: u32 = 0;
    let base_stem = match stem_index(&stem) {
        Some((i, num)) => {
            n = num;
            stem[..i].to_string()
        }
        None => stem.clone(),
    };
    loop {
        n += 1;
        let cand = join_remote(&parent, &format!("{base_stem} ({n}){ext}"));
        if remote_stat(env, key, &cand).await?.is_none() {
            return Ok(cand);
        }
    }
}

// ---- remote walks ----

struct RemoteEntry {
    path: String,
    is_dir: bool,
    size: u64,
    mtime: i64,
}

struct RemoteItem {
    root_is_dir: bool,
    root_size: u64,
    root_mtime: i64,
    /// sum of all file sizes below (and including) the root
    total_bytes: u64,
    /// descendants, parents before children, full remote paths
    entries: Vec<RemoteEntry>,
}

async fn scan_remote(ctx: &mut ACtx, env: &mut OpEnv, key: &str, rpath: &str) -> Result<RemoteItem, OpErr> {
    let st = remote_stat(env, key, rpath)
        .await?
        .ok_or_else(|| OpErr::Msg(format!("FTP: no such file or folder: {rpath}")))?;
    if !st.is_dir || st.is_symlink {
        return Ok(RemoteItem {
            root_is_dir: false,
            root_size: st.size,
            root_mtime: st.mtime,
            total_bytes: st.size,
            entries: Vec::new(),
        });
    }
    let mut entries = Vec::new();
    walk_remote_into(ctx, env, key, rpath, &mut entries).await?;
    let total_bytes = entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
    Ok(RemoteItem { root_is_dir: true, root_size: 0, root_mtime: st.mtime, total_bytes, entries })
}

async fn walk_remote_into(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    key: &str,
    dir: &str,
    out: &mut Vec<RemoteEntry>,
) -> Result<(), OpErr> {
    ctx.progress("scan", dir);
    for e in env.listing(key, dir).await? {
        let child = join_remote(dir, &e.name);
        let is_dir = e.is_dir && !e.is_symlink;
        out.push(RemoteEntry { path: child.clone(), is_dir, size: e.size, mtime: e.mtime });
        if is_dir {
            Box::pin(walk_remote_into(ctx, env, key, &child, out)).await?;
        }
    }
    Ok(())
}

// ---- delete primitives (F8 and move-cleanup) ----

/// depth-first delete of a remote folder
async fn delete_remote_dir(env: &mut OpEnv, key: &str, rdir: &str) -> Result<(), OpErr> {
    let entries = {
        let s = env.conn(key).await?;
        ctrl(list_remote(s, rdir)).await?
    };
    for e in entries {
        let child = join_remote(rdir, &e.name);
        if e.is_dir && !e.is_symlink {
            Box::pin(delete_remote_dir(env, key, &child)).await?;
        } else {
            let s = env.conn(key).await?;
            ctrl(s.stream.rm(&child)).await?;
        }
    }
    let s = env.conn(key).await?;
    ctrl(s.stream.rmdir(rdir)).await
}

/// delete one remote item (file or folder), statted through its parent
async fn delete_remote_item(env: &mut OpEnv, key: &str, rpath: &str) -> Result<(), OpErr> {
    match remote_stat(env, key, rpath).await? {
        Some(e) if e.is_dir && !e.is_symlink => delete_remote_dir(env, key, rpath).await,
        Some(_) => {
            let s = env.conn(key).await?;
            ctrl(s.stream.rm(rpath)).await
        }
        None => Err(OpErr::Msg(format!("FTP: no such file or folder: {rpath}"))),
    }
}

/// after a remote->X move: remove the copied sources; entries the user
/// skipped stay, and folders that still hold something stay with them
async fn delete_remote_source(
    env: &mut OpEnv,
    key: &str,
    rroot: &str,
    entries: &[RemoteEntry],
    skipped: &HashSet<String>,
) -> Result<(), OpErr> {
    for e in entries.iter().rev() {
        if e.is_dir {
            let s = env.conn(key).await?;
            let _ = ctrl(s.stream.rmdir(&e.path)).await; // non-empty (skipped children) -> keep
        } else if !skipped.contains(&e.path) {
            let s = env.conn(key).await?;
            ctrl(s.stream.rm(&e.path)).await?;
        }
    }
    let s = env.conn(key).await?;
    let _ = ctrl(s.stream.rmdir(rroot)).await;
    Ok(())
}

/// after a local->FTP move: remove the copied local tree, keeping skipped
/// entries and folders that are not empty any more
async fn remove_local_source(src: &Path, skipped: &HashSet<String>) {
    for entry in WalkDir::new(src).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if skipped.contains(&p.to_string_lossy().to_string()) {
            continue;
        }
        ensure_writable(p);
        let _ = tokio::fs::remove_file(p).await;
    }
    let mut dirs: Vec<PathBuf> = WalkDir::new(src)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir())
        .map(|e| e.path().to_path_buf())
        .collect();
    dirs.reverse();
    for d in dirs {
        let _ = tokio::fs::remove_dir(&d).await;
    }
}

// ---- streaming file primitives ----

fn set_mtime(p: &Path, mtime_ms: i64) {
    if mtime_ms <= 0 {
        return;
    }
    let ft = filetime::FileTime::from_unix_time(mtime_ms / 1000, ((mtime_ms % 1000) * 1_000_000) as u32);
    let _ = filetime::set_file_times(p, ft, ft);
}

async fn download_once(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    key: &str,
    rpath: &str,
    dst: &Path,
) -> Result<(), OpErr> {
    let (parent, name) = split_remote(rpath);
    let s = env.conn(key).await?;
    ctrl(s.stream.cwd(&parent)).await?;
    let mut ts = match tokio::time::timeout(CTRL_TIMEOUT, s.stream.retr_as_stream(&name)).await {
        Err(_) => return Err(OpErr::Conn("FTP: data connection stalled".into())),
        Ok(Err(e)) => return Err(map_ftp_err(e)),
        Ok(Ok(ts)) => ts,
    };
    let mut outf = tokio::fs::File::create(dst)
        .await
        .map_err(|e| OpErr::Msg(format!("{}: {e}", dst.display())))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if ctx.check_pause_cancel().await {
            return Err(OpErr::Cancelled);
        }
        let n = match tokio::time::timeout(DATA_IDLE_TIMEOUT, ts.read(&mut buf)).await {
            Err(_) => return Err(OpErr::Conn("FTP: data connection stalled".into())),
            Ok(Err(e)) => return Err(OpErr::Conn(format!("FTP: {e}"))),
            Ok(Ok(n)) => n,
        };
        if n == 0 {
            break;
        }
        outf.write_all(&buf[..n])
            .await
            .map_err(|e| OpErr::Msg(format!("{}: {e}", dst.display())))?;
        ctx.inner.bytes_done += n as u64;
        ctx.progress("transfer", rpath);
    }
    // finish reads the completion reply; failing here leaves the session suspect
    if let Err(e) = ts.finish().await {
        return Err(OpErr::Conn(format!("FTP: {e}")));
    }
    Ok(())
}

async fn download_file(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    key: &str,
    rpath: &str,
    dst: &Path,
) -> Result<(), OpErr> {
    // one retry on a fresh connection (restarts the file from byte zero)
    for attempt in 0..2 {
        let start = ctx.inner.bytes_done;
        match download_once(ctx, env, key, rpath, dst).await {
            Ok(()) => return Ok(()),
            Err(OpErr::Cancelled) => {
                env.drop_conn(key);
                return Err(OpErr::Cancelled);
            }
            Err(e) => {
                env.drop_conn(key);
                ctx.inner.bytes_done = start;
                if attempt == 0 {
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

async fn upload_once(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    key: &str,
    lpath: &Path,
    rparent: &str,
    rname: &str,
) -> Result<(), OpErr> {
    let mut inf = tokio::fs::File::open(lpath)
        .await
        .map_err(|e| OpErr::Msg(format!("{}: {e}", lpath.display())))?;
    let s = env.conn(key).await?;
    ctrl(s.stream.cwd(rparent)).await?;
    let mut ts = match tokio::time::timeout(CTRL_TIMEOUT, s.stream.put_with_stream(rname)).await {
        Err(_) => return Err(OpErr::Conn("FTP: data connection stalled".into())),
        Ok(Err(e)) => return Err(map_ftp_err(e)),
        Ok(Ok(ts)) => ts,
    };
    let mut buf = vec![0u8; CHUNK];
    loop {
        if ctx.check_pause_cancel().await {
            return Err(OpErr::Cancelled);
        }
        let n = match tokio::time::timeout(DATA_IDLE_TIMEOUT, inf.read(&mut buf)).await {
            Err(_) => return Err(OpErr::Msg("local read stalled".into())),
            Ok(Err(e)) => return Err(OpErr::Msg(format!("{}: {e}", lpath.display()))),
            Ok(Ok(n)) => n,
        };
        if n == 0 {
            break;
        }
        match tokio::time::timeout(DATA_IDLE_TIMEOUT, ts.write_all(&buf[..n])).await {
            Err(_) => return Err(OpErr::Conn("FTP: data connection stalled".into())),
            Ok(Err(e)) => return Err(OpErr::Conn(format!("FTP: {e}"))),
            Ok(Ok(())) => {}
        }
        ctx.inner.bytes_done += n as u64;
        ctx.progress("transfer", &lpath.to_string_lossy());
    }
    if let Err(e) = ts.finish().await {
        return Err(OpErr::Conn(format!("FTP: {e}")));
    }
    Ok(())
}

async fn upload_file(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    key: &str,
    lpath: &Path,
    rparent: &str,
    rname: &str,
) -> Result<(), OpErr> {
    for attempt in 0..2 {
        let start = ctx.inner.bytes_done;
        match upload_once(ctx, env, key, lpath, rparent, rname).await {
            Ok(()) => return Ok(()),
            Err(OpErr::Cancelled) => {
                env.drop_conn(key);
                return Err(OpErr::Cancelled);
            }
            Err(e) => {
                env.drop_conn(key);
                ctx.inner.bytes_done = start;
                if attempt == 0 {
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

// ---- conflict-aware single-file transfers ----

async fn download_with_conflict(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    key: &str,
    rpath: &str,
    dst: &Path,
    size: u64,
    mtime: i64,
    skipped: &mut HashSet<String>,
) -> Result<(), OpErr> {
    let mut d = dst.to_path_buf();
    if d.exists() {
        match ctx.ask_conflict(rpath, &d.to_string_lossy(), false).await.as_str() {
            "skip" => {
                ctx.inner.bytes_done += size;
                ctx.inner.files_done += 1;
                skipped.insert(rpath.to_string());
                return Ok(());
            }
            "rename" => d = auto_rename(&d),
            _ => {}
        }
    }
    download_file(ctx, env, key, rpath, &d).await?;
    set_mtime(&d, mtime);
    ctx.inner.files_done += 1;
    Ok(())
}

async fn upload_with_conflict(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    key: &str,
    lpath: &Path,
    rpath: &str,
    size: u64,
    skipped: &mut HashSet<String>,
) -> Result<(), OpErr> {
    let mut target = rpath.to_string();
    if let Some(st) = remote_stat(env, key, rpath).await? {
        // a file over an existing folder: overwrite will fail server-side,
        // mirroring the local engine's File::create on a directory
        match ctx.ask_conflict(&lpath.to_string_lossy(), rpath, st.is_dir).await.as_str() {
            "skip" => {
                ctx.inner.bytes_done += size;
                ctx.inner.files_done += 1;
                skipped.insert(lpath.to_string_lossy().to_string());
                return Ok(());
            }
            "rename" => target = auto_rename_remote(env, key, rpath).await?,
            _ => {}
        }
    }
    let (parent, name) = split_remote(&target);
    upload_file(ctx, env, key, lpath, &parent, &name).await?;
    ctx.inner.files_done += 1;
    Ok(())
}

/// FTP -> FTP through a temp file; both directions count bytes (mult = 2)
async fn relay_with_conflict(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    skey: &str,
    dkey: &str,
    rsrc: &str,
    rdst: &str,
    size: u64,
    skipped: &mut HashSet<String>,
) -> Result<(), OpErr> {
    let mut target = rdst.to_string();
    if let Some(st) = remote_stat(env, dkey, rdst).await? {
        match ctx.ask_conflict(rsrc, rdst, st.is_dir).await.as_str() {
            "skip" => {
                ctx.inner.bytes_done += size * 2;
                ctx.inner.files_done += 1;
                skipped.insert(rsrc.to_string());
                return Ok(());
            }
            "rename" => target = auto_rename_remote(env, dkey, rdst).await?,
            _ => {}
        }
    }
    let tmp = env.temp_path();
    download_file(ctx, env, skey, rsrc, &tmp).await?;
    let res = {
        let (parent, name) = split_remote(&target);
        upload_file(ctx, env, dkey, &tmp, &parent, &name).await
    };
    let _ = tokio::fs::remove_file(&tmp).await;
    res?;
    ctx.inner.files_done += 1;
    Ok(())
}

/// MKD unless the folder is already there; an existing file is an error
async fn ensure_remote_dir(env: &mut OpEnv, key: &str, rdir: &str) -> Result<(), OpErr> {
    if let Some(st) = remote_stat(env, key, rdir).await? {
        if st.is_dir {
            return Ok(());
        }
        return Err(OpErr::Msg(format!("FTP: already exists: {rdir}")));
    }
    let s = env.conn(key).await?;
    ctrl(s.stream.mkdir(rdir.to_string())).await
}

// ---- per-pair transfers ----

struct PairPlan {
    /// panel-style paths ("ftp://u@h:1/a" or "D:\a")
    src: String,
    dst: String,
    /// prescan result for remote sources
    remote: Option<RemoteItem>,
    /// how many times these bytes cross a wire (2 for FTP->FTP copies)
    mult: u64,
    /// move on one server: plain RNFR/RNTO, no copying
    fast_rename: bool,
}

async fn transfer_one(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    plan: &PairPlan,
    move_mode: bool,
) -> Result<(), OpErr> {
    let src_ftp = plan.src.starts_with("ftp://");
    let dst_ftp = plan.dst.starts_with("ftp://");
    match (src_ftp, dst_ftp) {
        (true, true) => transfer_remote_remote(ctx, env, plan, move_mode).await,
        (true, false) => transfer_remote_local(ctx, env, plan, move_mode).await,
        (false, true) => transfer_local_remote(ctx, env, plan, move_mode).await,
        (false, false) => Err(OpErr::Msg(
            "FTP: mixed local and FTP sources in one operation are not supported".into(),
        )),
    }
}

async fn transfer_remote_local(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    plan: &PairPlan,
    move_mode: bool,
) -> Result<(), OpErr> {
    let (creds, rsrc) = parse_ftp_path(&plan.src).map_err(OpErr::Msg)?;
    let key = creds.key();
    let item = plan.remote.as_ref().ok_or_else(|| OpErr::Msg("FTP: missing prescan".into()))?;
    let dst_root = PathBuf::from(&plan.dst);
    if item.root_is_dir {
        let mut dst = dst_root.clone();
        if dst.exists() && !dst.is_dir() {
            match ctx.ask_conflict(&plan.src, &plan.dst, true).await.as_str() {
                "skip" => {
                    ctx.inner.bytes_done += item.total_bytes * plan.mult;
                    return Ok(());
                }
                "rename" => dst = auto_rename(&dst),
                _ => {
                    let _ = tokio::fs::remove_file(&dst).await; // a folder replaces the file
                }
            }
        }
        tokio::fs::create_dir_all(&dst)
            .await
            .map_err(|e| OpErr::Msg(format!("{}: {e}", dst.display())))?;
        let mut skipped = HashSet::new();
        for e in &item.entries {
            if ctx.check_pause_cancel().await {
                return Err(OpErr::Cancelled);
            }
            let d = dst.join(rel_of(&e.path, &rsrc));
            if e.is_dir {
                tokio::fs::create_dir_all(&d)
                    .await
                    .map_err(|er| OpErr::Msg(format!("{}: {er}", d.display())))?;
                continue;
            }
            download_with_conflict(ctx, env, &key, &e.path, &d, e.size, e.mtime, &mut skipped)
                .await?;
        }
        if move_mode {
            delete_remote_source(env, &key, &rsrc, &item.entries, &skipped).await?;
        }
    } else {
        let mut skipped = HashSet::new();
        download_with_conflict(
            ctx,
            env,
            &key,
            &rsrc,
            &dst_root,
            item.root_size,
            item.root_mtime,
            &mut skipped,
        )
        .await?;
        if move_mode && !skipped.contains(&rsrc) {
            let s = env.conn(&key).await?;
            ctrl(s.stream.rm(rsrc.clone())).await?;
        }
    }
    Ok(())
}

async fn transfer_local_remote(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    plan: &PairPlan,
    move_mode: bool,
) -> Result<(), OpErr> {
    let (creds, rdst) = parse_ftp_path(&plan.dst).map_err(OpErr::Msg)?;
    let key = creds.key();
    let src = PathBuf::from(&plan.src);
    if src.is_dir() {
        let mut rroot = rdst.clone();
        if let Some(st) = remote_stat(env, &key, &rdst).await? {
            if !st.is_dir {
                match ctx.ask_conflict(&plan.src, &plan.dst, true).await.as_str() {
                    "skip" => {
                        ctx.inner.bytes_done += walk_size(&src);
                        return Ok(());
                    }
                    "rename" => rroot = auto_rename_remote(env, &key, &rdst).await?,
                    _ => {
                        delete_remote_item(env, &key, &rdst).await?; // the folder replaces the file
                    }
                }
            }
        }
        ensure_remote_dir(env, &key, &rroot).await?;
        let mut skipped = HashSet::new();
        for entry in WalkDir::new(&src).min_depth(1).follow_links(false) {
            if ctx.check_pause_cancel().await {
                return Err(OpErr::Cancelled);
            }
            let entry = entry
                .map_err(|e| OpErr::Msg(format!("{}: {e}", src.display())))?;
            let rel = entry.path().strip_prefix(&src).unwrap_or(entry.path());
            let rchild = join_remote(&rroot, &rel.to_string_lossy().replace('\\', "/"));
            if entry.file_type().is_dir() {
                ensure_remote_dir(env, &key, &rchild).await?;
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                upload_with_conflict(ctx, env, &key, entry.path(), &rchild, size, &mut skipped)
                    .await?;
            }
        }
        if move_mode {
            remove_local_source(&src, &skipped).await;
        }
    } else {
        let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        let mut skipped = HashSet::new();
        upload_with_conflict(ctx, env, &key, &src, &rdst, size, &mut skipped).await?;
        if move_mode && !skipped.contains(&plan.src) {
            ensure_writable(&src);
            tokio::fs::remove_file(&src)
                .await
                .map_err(|e| OpErr::Msg(format!("{}: {e}", src.display())))?;
        }
    }
    Ok(())
}

async fn transfer_remote_remote(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    plan: &PairPlan,
    move_mode: bool,
) -> Result<(), OpErr> {
    let (sc, rsrc) = parse_ftp_path(&plan.src).map_err(OpErr::Msg)?;
    let (dc, rdst) = parse_ftp_path(&plan.dst).map_err(OpErr::Msg)?;
    let (skey, dkey) = (sc.key(), dc.key());
    let same_server = skey.eq_ignore_ascii_case(&dkey);
    let item = plan.remote.as_ref().ok_or_else(|| OpErr::Msg("FTP: missing prescan".into()))?;
    if item.root_is_dir {
        // copying a folder into itself recurses forever — refuse instead
        if same_server && (rdst == rsrc || rdst.starts_with(&format!("{rsrc}/"))) {
            return Err(OpErr::Msg("cannot copy a directory into itself".into()));
        }
        let mut rroot = rdst.clone();
        if let Some(st) = remote_stat(env, &dkey, &rdst).await? {
            if !st.is_dir {
                match ctx.ask_conflict(&plan.src, &plan.dst, true).await.as_str() {
                    "skip" => {
                        ctx.inner.bytes_done += item.total_bytes * 2;
                        return Ok(());
                    }
                    "rename" => rroot = auto_rename_remote(env, &dkey, &rdst).await?,
                    _ => {
                        delete_remote_item(env, &dkey, &rdst).await?;
                    }
                }
            }
        }
        ensure_remote_dir(env, &dkey, &rroot).await?;
        let mut skipped = HashSet::new();
        for e in &item.entries {
            if ctx.check_pause_cancel().await {
                return Err(OpErr::Cancelled);
            }
            let rchild = join_remote(&rroot, &rel_of(&e.path, &rsrc));
            if e.is_dir {
                ensure_remote_dir(env, &dkey, &rchild).await?;
                continue;
            }
            relay_with_conflict(ctx, env, &skey, &dkey, &e.path, &rchild, e.size, &mut skipped)
                .await?;
        }
        if move_mode {
            delete_remote_source(env, &skey, &rsrc, &item.entries, &skipped).await?;
        }
    } else {
        let mut skipped = HashSet::new();
        relay_with_conflict(ctx, env, &skey, &dkey, &rsrc, &rdst, item.root_size, &mut skipped)
            .await?;
        if move_mode && !skipped.contains(&rsrc) {
            let s = env.conn(&skey).await?;
            ctrl(s.stream.rm(rsrc.clone())).await?;
        }
    }
    Ok(())
}

/// move between two folders of one server: RNFR/RNTO, instant
async fn rename_remote_item(ctx: &mut ACtx, env: &mut OpEnv, plan: &PairPlan) -> Result<(), OpErr> {
    let (sc, rsrc) = parse_ftp_path(&plan.src).map_err(OpErr::Msg)?;
    let (_dc, rdst) = parse_ftp_path(&plan.dst).map_err(OpErr::Msg)?;
    let key = sc.key();
    let is_dir = plan.remote.as_ref().map(|i| i.root_is_dir).unwrap_or(false);
    let mut target = rdst.clone();
    if let Some(st) = remote_stat(env, &key, &rdst).await? {
        match ctx.ask_conflict(&plan.src, &plan.dst, st.is_dir || is_dir).await.as_str() {
            "skip" => {
                ctx.inner.files_done += 1;
                return Ok(());
            }
            "rename" => target = auto_rename_remote(env, &key, &rdst).await?,
            _ => {
                delete_remote_item(env, &key, &rdst).await?;
            }
        }
    }
    let s = env.conn(&key).await?;
    ctrl(s.stream.rename(rsrc.clone(), target)).await?;
    ctx.inner.files_done += 1;
    Ok(())
}

// ---- operation entry points (called from ops.rs) ----

pub(crate) async fn run_transfer(
    app: AppHandle,
    mgr: OpManager,
    id: u32,
    h: Arc<OpHandle>,
    state: FtpState,
    paths: Vec<String>,
    dest: String,
    move_mode: bool,
) {
    let mut ctx = ACtx::new(app, id, h);
    let mut env = OpEnv::new(id, state);
    match run_transfer_inner(&mut ctx, &mut env, paths, dest, move_mode).await {
        Ok(()) => {}
        Err(OpErr::Cancelled) => ctx.inner.cancelled = true,
        Err(e) => ctx.inner.errors.push(OpError { path: String::new(), error: e.msg() }),
    }
    emit_done(&ctx.inner);
    mgr.finish(id);
    env.close().await;
}

async fn run_transfer_inner(
    ctx: &mut ACtx,
    env: &mut OpEnv,
    paths: Vec<String>,
    dest: String,
    move_mode: bool,
) -> Result<(), OpErr> {
    // ---- destination (mirrors ops::resolve_dest for both worlds) ----
    let dest = dest.trim().to_string();
    let remote_dest = dest.starts_with("ftp://");
    let (dest_dir, single_name): (String, Option<String>) = if remote_dest {
        let trimmed = dest.trim_end_matches('/').to_string();
        let ends_sep = trimmed.len() < dest.len();
        let (creds, dir) = parse_ftp_path(&trimmed).map_err(OpErr::Msg)?;
        let key = creds.key();
        // a trailing separator or an existing remote folder means "into it"
        let is_dir = ends_sep || env.listing(&key, &dir).await.is_ok();
        if !ends_sep && !is_dir && paths.len() == 1 {
            let (parent, name) = split_remote(&dir);
            (parent, Some(name))
        } else {
            (dir, None)
        }
    } else {
        let (d, n) = crate::ops::resolve_dest(&dest, paths.len());
        (d.to_string_lossy().to_string(), n)
    };
    let dest_auth = if remote_dest { authority_of(&dest) } else { "" };

    // ---- (src, dst) pairs; a target resolved back to the source is a no-op ----
    let mut pairs: Vec<(String, String)> = Vec::new();
    for p in paths {
        let name = base_name(&p);
        let dname = single_name.clone().unwrap_or_else(|| name);
        let dst = if remote_dest {
            format!("{}{}", dest_auth, join_remote(&dest_dir, &dname))
        } else {
            Path::new(&dest_dir).join(&dname).to_string_lossy().to_string()
        };
        if !same_item(&p, &dst) {
            pairs.push((p, dst));
        }
    }

    // ---- prescan ----
    ctx.progress("scan", "");
    let mut plans: Vec<PairPlan> = Vec::new();
    for (src, dst) in pairs {
        if ctx.check_pause_cancel().await {
            return Err(OpErr::Cancelled);
        }
        let fast = move_mode
            && src.starts_with("ftp://")
            && dst.starts_with("ftp://")
            && authority_of(&src).eq_ignore_ascii_case(authority_of(&dst));
        if !src.starts_with("ftp://") {
            let (b, f) = walk_stats([Path::new(&src)]);
            ctx.inner.bytes_total += b;
            ctx.inner.files_total += f;
            plans.push(PairPlan { src, dst, remote: None, mult: 1, fast_rename: false });
            continue;
        }
        let (creds, rsrc) = parse_ftp_path(&src).map_err(OpErr::Msg)?;
        let item = match scan_remote(ctx, env, &creds.key(), &rsrc).await {
            Ok(i) => i,
            Err(OpErr::Cancelled) => return Err(OpErr::Cancelled),
            Err(e) => {
                ctx.inner.errors.push(OpError { path: src.clone(), error: e.msg() });
                continue;
            }
        };
        let mult = if dst.starts_with("ftp://") { 2 } else { 1 };
        if fast {
            ctx.inner.files_total += 1;
        } else {
            let files = item.entries.iter().filter(|e| !e.is_dir).count() as u64
                + u64::from(!item.root_is_dir);
            ctx.inner.files_total += files;
            ctx.inner.bytes_total += item.total_bytes * mult;
        }
        plans.push(PairPlan { src, dst, remote: Some(item), mult, fast_rename: fast });
    }
    if plans.is_empty() {
        return Ok(());
    }

    // ---- transfer ----
    for plan in &plans {
        if ctx.check_pause_cancel().await {
            ctx.inner.cancelled = true;
            break;
        }
        ctx.progress("transfer", &plan.src);
        let res = if plan.fast_rename {
            rename_remote_item(ctx, env, plan).await
        } else {
            transfer_one(ctx, env, plan, move_mode).await
        };
        match res {
            Ok(()) => {}
            Err(OpErr::Cancelled) => {
                ctx.inner.cancelled = true;
                break;
            }
            Err(e) => ctx.inner.errors.push(OpError { path: plan.src.clone(), error: e.msg() }),
        }
    }
    Ok(())
}

pub(crate) async fn run_delete(
    app: AppHandle,
    mgr: OpManager,
    id: u32,
    h: Arc<OpHandle>,
    state: FtpState,
    paths: Vec<String>,
) {
    let mut ctx = ACtx::new(app, id, h);
    let mut env = OpEnv::new(id, state);
    // progress counted per selected path, like the local delete
    ctx.inner.files_total = paths.len() as u64;
    for p in &paths {
        if ctx.check_pause_cancel().await {
            break;
        }
        ctx.progress("delete", p);
        let res = match parse_ftp_path(p) {
            Ok((creds, rpath)) => delete_remote_item(&mut env, &creds.key(), &rpath).await,
            Err(e) => Err(OpErr::Msg(e)),
        };
        if let Err(e) = res {
            if e == OpErr::Cancelled {
                ctx.inner.cancelled = true;
                break;
            }
            ctx.inner.errors.push(OpError { path: p.clone(), error: e.msg() });
        }
        ctx.inner.files_done += 1;
    }
    emit_done(&ctx.inner);
    mgr.finish(id);
    env.close().await;
}
