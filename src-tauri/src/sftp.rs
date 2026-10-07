// SFTP browsing (V2, mirrors ftp.rs). Panels address the server with paths
// of the form sftp://user@host:port/dir — the password never appears in a
// path, it lives in the session kept here and in ftp-sites.json (a site with
// secure=true). Sessions are keyed by "user@host:port"; a failed operation
// drops the session and reconnects once with the saved credentials. Unlike
// FTP the creds also live in a separate map: an SSH session can die while
// its credentials are still needed for the reconnect.
use crate::fs::{DirListing, EntryDto};
use crate::textio::{decode_content, encode_text, HexChunk, TextContent};
use async_trait::async_trait;
use russh::client::Handler;
use russh_sftp::client::SftpSession as RawSftp;
use russh_sftp::protocol::OpenFlags;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Mutex;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const OP_TIMEOUT: Duration = Duration::from_secs(60);
/// hard cap for a single file pulled into memory (text/hex viewer)
const MAX_SFTP_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct SftpCreds {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) user: String,
    pub(crate) password: String,
}

impl SftpCreds {
    /// key of the sessions/creds maps (same shape as FTP: "user@host:port")
    pub(crate) fn key(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
    /// panel path of the server root
    pub(crate) fn root(&self) -> String {
        format!("sftp://{}@{}:{}", self.user, self.host, self.port)
    }
}

/// The SSH connection this session runs over accepts any host key on the
/// first connect (FTP has no verification at all; known-hosts pinning is a
/// follow-up). Every other Handler method keeps its default.
struct AcceptAnyHostKey;

#[async_trait]
impl Handler for AcceptAnyHostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct SftpSession {
    pub(crate) sftp: RawSftp,
}

/// Clone so an operation can carry the state handle into its worker task;
/// the maps themselves stay shared. Ops open their own SSH connections from
/// the creds (remote_ops.rs), exactly like FTP.
#[derive(Clone, Default)]
pub struct SftpState {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>>,
    creds: Arc<Mutex<HashMap<String, SftpCreds>>>,
}

impl SftpState {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn get(&self, key: &str) -> Result<Arc<Mutex<SftpSession>>, String> {
        self.sessions
            .lock()
            .await
            .get(key)
            .cloned()
            .ok_or_else(|| "SFTP: not connected — open the drive menu (Alt+F1/F2 → SFTP) first".to_string())
    }

    pub(crate) async fn put(&self, creds: SftpCreds, s: SftpSession) -> Arc<Mutex<SftpSession>> {
        let key = creds.key();
        self.creds.lock().await.insert(key.clone(), creds);
        let arc = Arc::new(Mutex::new(s));
        self.sessions.lock().await.insert(key, arc.clone());
        arc
    }

    async fn remove(&self, key: &str) {
        self.sessions.lock().await.remove(key);
    }

    /// credentials of the site (live or dead session) — used to open the
    /// dedicated transfer connections in remote_ops
    pub(crate) async fn creds_for(&self, key: &str) -> Option<SftpCreds> {
        self.creds.lock().await.get(key).cloned()
    }
}

/// "sftp://user@host:port/a/b" -> (creds for the session key, remote dir "/a/b").
/// The password read from the path is always empty — reconnects use the
/// credentials stored in the live session instead.
pub(crate) fn parse_sftp_path(path: &str) -> Result<(SftpCreds, String), String> {
    let rest = path
        .strip_prefix("sftp://")
        .ok_or_else(|| format!("SFTP: not an sftp path: {path}"))?;
    let (auth, dir) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (user, hostport) = match auth.rfind('@') {
        Some(i) => (auth[..i].to_string(), &auth[i + 1..]),
        None => (String::new(), auth),
    };
    let (host, port) = match hostport.rfind(':') {
        Some(i) => (
            hostport[..i].to_string(),
            hostport[i + 1..]
                .parse::<u16>()
                .map_err(|_| format!("SFTP: bad port in {path}"))?,
        ),
        None => (hostport.to_string(), 22),
    };
    if host.is_empty() {
        return Err(format!("SFTP: empty host in {path}"));
    }
    let user = if user.is_empty() { "anonymous".to_string() } else { user };
    let dir = if dir.is_empty() { "/".to_string() } else { dir };
    Ok((SftpCreds { host, port, user, password: String::new() }, dir))
}

pub(crate) async fn connect_sftp(creds: &SftpCreds) -> Result<SftpSession, String> {
    let config = Arc::new(russh::client::Config::default());
    let mut session = tokio::time::timeout(
        CONNECT_TIMEOUT,
        russh::client::connect(config, (creds.host.as_str(), creds.port), AcceptAnyHostKey),
    )
    .await
    .map_err(|_| format!("SFTP: connect timeout — {}", creds.host))?
    .map_err(|e| format!("SFTP: {e}"))?;
    let ok = tokio::time::timeout(CONNECT_TIMEOUT, session.authenticate_password(&creds.user, &creds.password))
        .await
        .map_err(|_| "SFTP: login timeout".to_string())?
        .map_err(|e| format!("SFTP: {e}"))?;
    if !ok {
        return Err("SFTP: wrong username or password".to_string());
    }
    let channel = tokio::time::timeout(CONNECT_TIMEOUT, session.channel_open_session())
        .await
        .map_err(|_| "SFTP: channel timeout".to_string())?
        .map_err(|e| format!("SFTP: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP: {e}"))?;
    let sftp = tokio::time::timeout(CONNECT_TIMEOUT, RawSftp::new(channel.into_stream()))
        .await
        .map_err(|_| "SFTP: subsystem timeout".to_string())?
        .map_err(|e| format!("SFTP: {e}"))?;
    Ok(SftpSession { sftp })
}

/// Run an SFTP operation on the live session; on failure reconnect once with
/// the saved credentials and retry (the SSH connection may have died while
/// the app was idle).
async fn with_retry<T>(
    state: &SftpState,
    key: &str,
    mut op: impl AsyncFnMut(&mut SftpSession) -> Result<T, String>,
) -> Result<T, String> {
    let sess = state.get(key).await?;
    {
        let mut s = sess.lock().await;
        if let Ok(v) = tokio::time::timeout(OP_TIMEOUT, op(&mut s)).await {
            return v;
        }
    }
    let creds = state
        .creds_for(key)
        .await
        .ok_or_else(|| format!("SFTP: not connected — {key}"))?;
    state.remove(key).await;
    let fresh = connect_sftp(&creds).await?;
    let arc = state.put(creds, fresh).await;
    let mut s = arc.lock().await;
    tokio::time::timeout(OP_TIMEOUT, op(&mut s))
        .await
        .map_err(|_| "SFTP: operation timeout".to_string())?
}

/// russh-sftp DirEntry -> EntryDto (skips "." / "..")
fn entry_of(e: &russh_sftp::client::fs::DirEntry) -> Option<EntryDto> {
    let name = e.file_name();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let m = e.metadata();
    let is_symlink = m.is_symlink();
    Some(EntryDto {
        is_dir: !is_symlink && m.is_dir(),
        size: m.size.unwrap_or(0),
        mtime: m.mtime.map(|s| s as i64 * 1000).unwrap_or(0),
        is_hidden: name.starts_with('.'),
        name,
        attrs: String::new(),
        is_symlink,
    })
}

/// list `dir` and report the filesystem's free/total bytes (statvfs
/// extension; servers without it report 0, like FTP)
pub(crate) async fn list_remote(s: &mut SftpSession, dir: &str) -> Result<(Vec<EntryDto>, u64, u64), String> {
    let rd = s.sftp.read_dir(dir).await.map_err(|e| format!("SFTP: {e}"))?;
    let mut entries: Vec<EntryDto> = Vec::new();
    for e in rd {
        if let Some(dto) = entry_of(&e) {
            entries.push(dto);
        }
    }
    let (free, total) = match s.sftp.fs_info(dir).await {
        Ok(Some(v)) => (v.block_size.saturating_mul(v.blocks_free), v.block_size.saturating_mul(v.blocks)),
        _ => (0, 0),
    };
    Ok((entries, free, total))
}

#[tauri::command]
pub async fn sftp_connect(
    host: String,
    port: u16,
    user: String,
    password: String,
    state: tauri::State<'_, SftpState>,
) -> Result<String, String> {
    if host.trim().is_empty() {
        return Err("SFTP: host is empty".to_string());
    }
    let user = if user.trim().is_empty() { "test".to_string() } else { user };
    let creds = SftpCreds {
        host: host.trim().to_string(),
        port: if port == 0 { 22 } else { port },
        user,
        password,
    };
    let root = creds.root();
    let key = creds.key();
    let session = connect_sftp(&creds).await?;
    state.put(creds, session).await;
    // start where the server starts us (the account home), not at "/" —
    // canonicalize(".") is what the server answers for the initial cwd
    if let Ok(sess) = state.get(&key).await {
        let start = {
            let s = sess.lock().await;
            s.sftp.canonicalize(".").await.unwrap_or_else(|_| "/".to_string())
        };
        let start = start.trim_end_matches('/').to_string();
        if !start.is_empty() && start != "/" {
            return Ok(format!("{root}{start}"));
        }
    }
    Ok(root)
}

#[tauri::command]
pub async fn sftp_list(path: String, state: tauri::State<'_, SftpState>) -> Result<DirListing, String> {
    let (creds, dir) = parse_sftp_path(&path)?;
    let key = creds.key();
    let dir_clone = dir.clone();
    let (entries, free, total) = with_retry(&state, &key, async move |s: &mut SftpSession| {
        list_remote(s, &dir_clone).await
    })
    .await?;
    Ok(DirListing { path, entries, free_bytes: free, total_bytes: total })
}

/// pull the whole file into memory (capped), starting at `offset`
async fn read_remote(s: &mut SftpSession, file: &str, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut f = s
        .sftp
        .open_with_flags(file, OpenFlags::READ)
        .await
        .map_err(|e| format!("SFTP: {e}"))?;
    if offset > 0 {
        f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| format!("SFTP: {e}"))?;
    }
    let mut buf = Vec::new();
    let mut limited = (&mut f).take(len);
    limited.read_to_end(&mut buf).await.map_err(|e| format!("SFTP: {e}"))?;
    Ok(buf)
}

#[tauri::command]
pub async fn sftp_read_text(
    path: String,
    encoding: Option<String>,
    fallback: Option<String>,
    state: tauri::State<'_, SftpState>,
) -> Result<TextContent, String> {
    let (creds, file) = parse_sftp_path(&path)?;
    let key = creds.key();
    let bytes = with_retry(&state, &key, async move |s: &mut SftpSession| {
        read_remote(s, &file, 0, MAX_SFTP_BYTES).await
    })
    .await?;
    decode_content(
        &bytes,
        bytes.len() as u64,
        encoding.as_deref(),
        fallback.as_deref().unwrap_or("windows-1251"),
    )
}

#[tauri::command]
pub async fn sftp_write_text(
    path: String,
    content: String,
    encoding: String,
    eol: String,
    state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let (creds, file) = parse_sftp_path(&path)?;
    let key = creds.key();
    let bytes = encode_text(content, &encoding, &eol)?;
    if bytes.len() as u64 > MAX_SFTP_BYTES {
        return Err("SFTP: file too large to upload".to_string());
    }
    with_retry(&state, &key, async move |s: &mut SftpSession| {
        s.sftp
            .write(&file, &bytes)
            .await
            .map_err(|e| format!("SFTP: {e}"))
    })
    .await
}

#[tauri::command]
pub async fn sftp_read_hex(
    path: String,
    offset: u64,
    len: u32,
    state: tauri::State<'_, SftpState>,
) -> Result<HexChunk, String> {
    let (creds, file) = parse_sftp_path(&path)?;
    let key = creds.key();
    let (bytes, file_size) = with_retry(&state, &key, async move |s: &mut SftpSession| {
        let size = s
            .sftp
            .metadata(&file)
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0);
        let want = (len as u64).min(MAX_SFTP_BYTES);
        let data = read_remote(s, &file, offset, want).await?;
        Ok::<_, String>((data, size))
    })
    .await?;
    Ok(HexChunk { data: bytes, file_size })
}

#[tauri::command]
pub async fn sftp_mkdir(path: String, state: tauri::State<'_, SftpState>) -> Result<(), String> {
    let (creds, dir) = parse_sftp_path(&path)?;
    if dir == "/" {
        return Err("SFTP: empty folder name".to_string());
    }
    let key = creds.key();
    with_retry(&state, &key, async move |s: &mut SftpSession| {
        s.sftp.create_dir(&dir).await.map_err(|e| format!("SFTP: {e}"))
    })
    .await
}

/// rename on one server (Shift+F6 on an SFTP panel). SFTP v3 rename fails
/// when the target exists (unlike FTP RNTO), so no pre-check is needed.
#[tauri::command]
pub async fn sftp_rename(old: String, new: String, state: tauri::State<'_, SftpState>) -> Result<(), String> {
    let (from_creds, from) = parse_sftp_path(&old)?;
    let (to_creds, to) = parse_sftp_path(&new)?;
    if from_creds.key() != to_creds.key() {
        return Err("SFTP: rename must stay on the same server".to_string());
    }
    if from == to {
        return Ok(());
    }
    let key = from_creds.key();
    with_retry(&state, &key, async move |s: &mut SftpSession| {
        s.sftp.rename(&from, &to).await.map_err(|e| format!("SFTP: {e}"))
    })
    .await
}
