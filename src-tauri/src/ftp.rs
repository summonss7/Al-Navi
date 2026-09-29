// FTP browsing (drive menu → FTP). Panels address the server with paths of
// the form ftp://user@host:port/dir — the password never appears in a path,
// it lives in the session kept here and in ftp-sites.json. Sessions are
// keyed by "user@host:port"; a failed operation drops the session and
// reconnects once with the saved credentials.
use crate::fs::{DirListing, EntryDto};
use crate::textio::{decode_content, encode_text, HexChunk, TextContent};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use suppaftp::list::ListParser;
use suppaftp::tokio::AsyncFtpStream;
use suppaftp::types::FileType;
use suppaftp::FtpResult;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const OP_TIMEOUT: Duration = Duration::from_secs(60);
/// hard cap for a single file pulled into memory (text/hex viewer)
const MAX_FTP_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct FtpCreds {
    host: String,
    port: u16,
    user: String,
    password: String,
}

impl FtpCreds {
    fn key(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
    /// panel path of the server root
    fn root(&self) -> String {
        format!("ftp://{}@{}:{}", self.user, self.host, self.port)
    }
}

pub struct FtpSession {
    stream: AsyncFtpStream,
    creds: FtpCreds,
}

#[derive(Default)]
pub struct FtpState {
    sessions: Mutex<HashMap<String, Arc<Mutex<FtpSession>>>>,
}

impl FtpState {
    pub fn new() -> Self {
        Self::default()
    }

    async fn get(&self, key: &str) -> Result<Arc<Mutex<FtpSession>>, String> {
        self.sessions
            .lock()
            .await
            .get(key)
            .cloned()
            .ok_or_else(|| "FTP: not connected — open the drive menu (Alt+F1/F2 → FTP) first".to_string())
    }

    async fn put(&self, key: String, s: FtpSession) -> Arc<Mutex<FtpSession>> {
        let arc = Arc::new(Mutex::new(s));
        self.sessions.lock().await.insert(key, arc.clone());
        arc
    }

    async fn remove(&self, key: &str) {
        self.sessions.lock().await.remove(key);
    }
}

/// "ftp://user@host:port/a/b" -> (creds for the session key, remote dir "/a/b").
/// The password read from the path is always empty — reconnects use the
/// credentials stored in the live session instead.
fn parse_ftp_path(path: &str) -> Result<(FtpCreds, String), String> {
    let rest = path
        .strip_prefix("ftp://")
        .ok_or_else(|| format!("FTP: not an ftp path: {path}"))?;
    let (auth, dir) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (user, hostport) = match auth.rfind('@') {
        Some(i) => (auth[..i].to_string(), &auth[i + 1..]),
        None => ("anonymous".to_string(), auth),
    };
    let (host, port) = match hostport.rfind(':') {
        Some(i) => (
            hostport[..i].to_string(),
            hostport[i + 1..]
                .parse::<u16>()
                .map_err(|_| format!("FTP: bad port in {path}"))?,
        ),
        None => (hostport.to_string(), 21),
    };
    if host.is_empty() {
        return Err(format!("FTP: empty host in {path}"));
    }
    let user = if user.is_empty() { "anonymous".to_string() } else { user };
    let dir = if dir.is_empty() { "/".to_string() } else { dir };
    Ok((
        FtpCreds { host, port, user, password: String::new() },
        dir,
    ))
}

/// split "/a/b/file.txt" -> ("/a/b", "file.txt")
fn split_remote(dir: &str) -> (String, String) {
    let name = dir.rsplit('/').next().unwrap_or("").to_string();
    let parent = &dir[..dir.len() - name.len()];
    let parent = if parent.is_empty() { "/".to_string() } else { parent.to_string() };
    (parent, name)
}

async fn connect_session(creds: &FtpCreds) -> Result<FtpSession, String> {
    let addr = format!("{}:{}", creds.host, creds.port);
    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, AsyncFtpStream::connect(&addr))
        .await
        .map_err(|_| format!("FTP: connect timeout — {}", creds.host))?
        .map_err(|e| format!("FTP: {e}"))?;
    tokio::time::timeout(CONNECT_TIMEOUT, stream.login(&creds.user, &creds.password))
        .await
        .map_err(|_| "FTP: login timeout".to_string())?
        .map_err(|e| format!("FTP: {e}"))?;
    stream
        .transfer_type(FileType::Binary)
        .await
        .map_err(|e| format!("FTP: {e}"))?;
    Ok(FtpSession { stream, creds: creds.clone() })
}

/// Run an FTP operation on the live session; on failure reconnect once with
/// the saved credentials and retry (stale control connections are common).
async fn with_retry<T>(
    state: &FtpState,
    key: &str,
    mut op: impl AsyncFnMut(&mut FtpSession) -> FtpResult<T>,
) -> Result<T, String> {
    let sess = state.get(key).await?;
    if let Ok(Ok(v)) = {
        let mut s = sess.lock().await;
        tokio::time::timeout(OP_TIMEOUT, op(&mut s)).await
    } {
        return Ok(v);
    }
    let creds = sess.lock().await.creds.clone();
    state.remove(key).await;
    let fresh = connect_session(&creds).await?;
    let arc = state.put(key.to_string(), fresh).await;
    let mut s = arc.lock().await;
    tokio::time::timeout(OP_TIMEOUT, op(&mut s))
        .await
        .map_err(|_| "FTP: operation timeout".to_string())?
        .map_err(|e| format!("FTP: {e}"))
}

/// one MLSD or LIST line -> EntryDto (None for "."/".." and unparsable lines)
fn parse_entry_line(line: &str, mlsd: bool) -> Option<EntryDto> {
    let f = if mlsd {
        ListParser::parse_mlsd(line).ok()?
    } else {
        ListParser::parse_posix(line)
            .ok()
            .or_else(|| ListParser::parse_dos(line).ok())?
    };
    let name = f.name().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let mtime = f
        .modified()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(EntryDto {
        name,
        is_dir: f.is_directory(),
        size: f.size() as u64,
        mtime,
        attrs: String::new(),
        is_symlink: f.is_symlink(),
        is_hidden: f.name().starts_with('.'),
    })
}

#[tauri::command]
pub async fn ftp_connect(
    host: String,
    port: u16,
    user: String,
    password: String,
    state: tauri::State<'_, FtpState>,
) -> Result<String, String> {
    let user = if user.trim().is_empty() { "anonymous".to_string() } else { user };
    let creds = FtpCreds { host: host.trim().to_string(), port: if port == 0 { 21 } else { port }, user, password };
    if creds.host.is_empty() {
        return Err("FTP: host is empty".to_string());
    }
    let root = creds.root();
    let session = connect_session(&creds).await?;
    state.put(creds.key(), session).await;
    Ok(root)
}

#[tauri::command]
pub async fn ftp_list(path: String, state: tauri::State<'_, FtpState>) -> Result<DirListing, String> {
    let (creds, dir) = parse_ftp_path(&path)?;
    let dir_clone = dir.clone();
    let entries = with_retry(&state, &creds.key(), async move |s: &mut FtpSession| {
        s.stream.cwd(&dir_clone).await?;
        // MLSD is machine-readable; fall back to parsing human LIST output
        match s.stream.mlsd(None).await {
            Ok(lines) => Ok(lines.iter().filter_map(|l| parse_entry_line(l, true)).collect()),
            Err(_) => {
                let lines = s.stream.list(None).await?;
                Ok(lines.iter().filter_map(|l| parse_entry_line(l, false)).collect())
            }
        }
    })
    .await?;
    Ok(DirListing {
        path,
        entries,
        free_bytes: 0,
        total_bytes: 0,
    })
}

#[tauri::command]
pub async fn ftp_read_text(
    path: String,
    encoding: Option<String>,
    fallback: Option<String>,
    state: tauri::State<'_, FtpState>,
) -> Result<TextContent, String> {
    let (creds, file) = parse_ftp_path(&path)?;
    let (parent, name) = split_remote(&file);
    let bytes = with_retry(&state, &creds.key(), async move |s: &mut FtpSession| {
        read_remote(&mut s.stream, &parent, &name).await
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
pub async fn ftp_write_text(
    path: String,
    content: String,
    encoding: String,
    eol: String,
    state: tauri::State<'_, FtpState>,
) -> Result<(), String> {
    let (creds, file) = parse_ftp_path(&path)?;
    let (parent, name) = split_remote(&file);
    let bytes = encode_text(content, &encoding, &eol)?;
    if bytes.len() > MAX_FTP_BYTES {
        return Err("FTP: file too large to upload".to_string());
    }
    with_retry(&state, &creds.key(), async move |s: &mut FtpSession| {
        s.stream.cwd(&parent).await?;
        s.stream.put_file(&name, &mut bytes.as_slice()).await.map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn ftp_read_hex(
    path: String,
    offset: u64,
    len: u32,
    state: tauri::State<'_, FtpState>,
) -> Result<HexChunk, String> {
    let (creds, file) = parse_ftp_path(&path)?;
    let (parent, name) = split_remote(&file);
    let bytes = with_retry(&state, &creds.key(), async move |s: &mut FtpSession| {
        read_remote(&mut s.stream, &parent, &name).await
    })
    .await?;
    let file_size = bytes.len() as u64;
    let start = (offset as usize).min(bytes.len());
    let end = (start + len as usize).min(bytes.len());
    Ok(HexChunk { data: bytes[start..end].to_vec(), file_size })
}

#[tauri::command]
pub async fn ftp_mkdir(path: String, state: tauri::State<'_, FtpState>) -> Result<(), String> {
    let (creds, dir) = parse_ftp_path(&path)?;
    if dir == "/" {
        return Err("FTP: empty folder name".to_string());
    }
    with_retry(&state, &creds.key(), async move |s: &mut FtpSession| {
        s.stream.mkdir(&dir).await
    })
    .await
}

/// cwd into the parent folder and pull the whole file into memory (capped)
async fn read_remote(stream: &mut AsyncFtpStream, parent: &str, name: &str) -> FtpResult<Vec<u8>> {
    stream.cwd(parent).await?;
    let mut ts = stream.retr_as_stream(name).await?;
    let mut buf = Vec::new();
    // take() on a mutable borrow keeps the stream usable for finish()
    let mut limited = (&mut ts).take(MAX_FTP_BYTES as u64);
    limited
        .read_to_end(&mut buf)
        .await
        .map_err(suppaftp::FtpError::ConnectionError)?;
    drop(limited);
    ts.finish().await?;
    Ok(buf)
}
