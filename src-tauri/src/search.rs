use crate::fs::build_entry;
use crate::textio::decode_content;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

/// Per-file read cap for content search (same limit as the editor).
const MAX_TEXT_BYTES: u64 = 64 * 1024 * 1024;
/// Hits are streamed in batches, throttled like op:progress.
const EMIT_INTERVAL_MS: u128 = 120;
/// Hard cap so a pathological burst can't grow the buffer unboundedly
/// between throttled emits.
const MAX_BUFFERED_HITS: usize = 1000;
const MAX_ERRORS: usize = 50;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub root: String,
    /// FAR-style comma-separated masks ("*.txt, *.md"); empty = "*"
    pub mask: String,
    #[serde(default)]
    pub use_regex: bool,
    /// Text to find inside files (encoding auto-detected, textio)
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub text_case_sensitive: bool,
    /// mtime range bounds, ms since epoch
    #[serde(default)]
    pub date_from: Option<i64>,
    #[serde(default)]
    pub date_to: Option<i64>,
    /// File size range bounds, bytes
    #[serde(default)]
    pub size_from: Option<u64>,
    #[serde(default)]
    pub size_to: Option<u64>,
    /// Directories matching by name count as hits (size/content filters
    /// exclude them by nature)
    #[serde(default = "default_true")]
    pub find_dirs: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitDto {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    pub attrs: String,
    pub is_symlink: bool,
    pub is_hidden: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitsEvent {
    pub id: u32,
    pub hits: Vec<SearchHitDto>,
    pub scanned: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchDoneEvent {
    pub id: u32,
    pub cancelled: bool,
    pub errors: Vec<String>,
    pub scanned: u64,
    pub hits: u64,
    pub elapsed_ms: u64,
}

// ---------- FAR-style file masks (same semantics as the frontend maskToRegExp) ----------

#[derive(Clone, PartialEq)]
enum Tok {
    Star,
    Question,
    Lit(char),
}

fn compile_mask(mask: &str) -> Vec<Vec<Tok>> {
    let mut patterns = Vec::new();
    for part in mask.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        patterns.push(
            part.chars()
                .flat_map(|c| c.to_lowercase())
                .map(|c| match c {
                    '*' => Tok::Star,
                    '?' => Tok::Question,
                    other => Tok::Lit(other),
                })
                .collect(),
        );
    }
    if patterns.is_empty() {
        patterns.push(vec![Tok::Star]); // empty mask = "*"
    }
    patterns
}

/// Iterative wildcard match with star backtracking (no regex engine needed).
fn match_pattern(toks: &[Tok], name: &[char]) -> bool {
    let (mut ti, mut ni) = (0usize, 0usize);
    let (mut star_ti, mut star_ni) = (usize::MAX, 0usize);
    while ni < name.len() {
        match toks.get(ti) {
            Some(Tok::Star) => {
                star_ti = ti;
                star_ni = ni;
                ti += 1;
            }
            Some(Tok::Question) => {
                ti += 1;
                ni += 1;
            }
            Some(Tok::Lit(c)) if *c == name[ni] => {
                ti += 1;
                ni += 1;
            }
            _ => {
                if star_ti == usize::MAX {
                    return false;
                }
                star_ni += 1;
                ni = star_ni;
                ti = star_ti + 1;
            }
        }
    }
    while matches!(toks.get(ti), Some(Tok::Star)) {
        ti += 1;
    }
    ti == toks.len()
}

enum Matcher {
    Masks(Vec<Vec<Tok>>),
    Regex(Regex),
}

impl Matcher {
    fn matches(&self, name: &str) -> bool {
        match self {
            Matcher::Regex(re) => re.is_match(name),
            Matcher::Masks(patterns) => {
                let lowered: Vec<char> = name.to_lowercase().chars().collect();
                patterns.iter().any(|p| match_pattern(p, &lowered))
            }
        }
    }
}

// ---------- search registry (cancel flags per running search) ----------

struct SearchManagerInner {
    next_id: AtomicU32,
    handles: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

#[derive(Clone)]
pub struct SearchManager {
    inner: Arc<SearchManagerInner>,
}

impl SearchManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SearchManagerInner {
                next_id: AtomicU32::new(1),
                handles: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Register a new search; starting one cancels every still-running search.
    fn register(&self) -> (u32, Arc<AtomicBool>) {
        let mut handles = self.inner.handles.lock().unwrap();
        for h in handles.values() {
            h.store(true, Ordering::Relaxed);
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(AtomicBool::new(false));
        handles.insert(id, cancel.clone());
        (id, cancel)
    }

    fn finish(&self, id: u32) {
        self.inner.handles.lock().unwrap().remove(&id);
    }
}

impl Default for SearchManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- content search worker pool ----------

struct SearchText {
    raw: String,
    lower: String,
    case_sensitive: bool,
}

struct TextJob {
    path: PathBuf,
    hit: SearchHitDto,
}

enum WorkerReply {
    Hit(SearchHitDto),
    Err(String),
}

/// Read a file (capped at MAX_TEXT_BYTES) and test whether its decoded text
/// contains the needle. Encoding auto-detection is shared with the editor
/// (textio::decode_content), so UTF-8/UTF-16/CP1251/KOI8-R are all covered.
fn file_contains(
    path: &Path,
    text: &SearchText,
) -> std::io::Result<bool> {
    let mut f = fs::File::open(path)?;
    let size = f.metadata()?.len();
    let take = size.min(MAX_TEXT_BYTES) as usize;
    let mut buf = Vec::with_capacity(take.min(4 * 1024 * 1024));
    let mut limited = (&mut f).take(take as u64);
    limited.read_to_end(&mut buf)?;
    // decode errors can't happen with encoding=None; treat them as no-match
    let Ok(content) = decode_content(&buf, size, None, "windows-1251") else {
        return Ok(false);
    };
    // NUL bytes surviving a single-byte fallback decode = binary file
    if content.encoding == "windows-1251" && buf.contains(&0u8) {
        return Ok(false);
    }
    if text.case_sensitive {
        Ok(content.text.contains(&text.raw))
    } else {
        Ok(content.text.to_lowercase().contains(&text.lower))
    }
}

fn text_worker(
    jobs: Arc<Mutex<mpsc::Receiver<TextJob>>>,
    replies: mpsc::Sender<WorkerReply>,
    text: Arc<SearchText>,
    cancel: Arc<AtomicBool>,
) {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        // recv() while holding the lock only serializes job pickup, not the
        // per-file work itself
        let job = {
            let rx = jobs.lock().unwrap();
            match rx.recv() {
                Ok(j) => j,
                Err(_) => return, // channel closed: the walk is over
            }
        };
        let reply = match file_contains(&job.path, &text) {
            Ok(true) => WorkerReply::Hit(job.hit),
            Ok(false) => continue,
            Err(e) => WorkerReply::Err(format!("{}: {}", job.path.display(), e)),
        };
        if replies.send(reply).is_err() {
            return;
        }
    }
}

fn drain_replies(
    rx: &mpsc::Receiver<WorkerReply>,
    buffer: &mut Vec<SearchHitDto>,
    hit_count: &mut u64,
    errors: &mut Vec<String>,
) {
    loop {
        match rx.try_recv() {
            Ok(WorkerReply::Hit(h)) => {
                *hit_count += 1;
                buffer.push(h);
            }
            Ok(WorkerReply::Err(e)) => push_error(errors, e),
            Err(_) => break,
        }
    }
}

fn push_error(errors: &mut Vec<String>, msg: String) {
    if errors.len() < MAX_ERRORS {
        errors.push(msg);
    }
}

#[allow(clippy::too_many_arguments)]
fn run_search(
    app: AppHandle,
    mgr: SearchManager,
    id: u32,
    cancel: Arc<AtomicBool>,
    root: PathBuf,
    matcher: Matcher,
    text: Option<SearchText>,
    date_from: Option<i64>,
    date_to: Option<i64>,
    size_from: Option<u64>,
    size_to: Option<u64>,
    find_dirs: bool,
) {
    let started = Instant::now();
    let mut scanned: u64 = 0;
    let mut hit_count: u64 = 0;
    let mut errors: Vec<String> = Vec::new();
    let mut buffer: Vec<SearchHitDto> = Vec::new();
    let mut last_emit = Instant::now();
    let mut cancelled = false;

    // Content search runs on a small thread pool: the walker hands candidate
    // files over, workers decode and match, replies stream back to this thread
    // (which stays the only emitter). Without a text filter no pool is spawned.
    let (job_tx, replies_rx, worker_handles) = match &text {
        Some(t) => {
            let (tx, rx) = mpsc::channel::<TextJob>();
            let (rtx, rrx) = mpsc::channel::<WorkerReply>();
            let rx = Arc::new(Mutex::new(rx));
            let n = thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
                .min(8)
                .max(1);
            let shared_text = Arc::new(SearchText {
                raw: t.raw.clone(),
                lower: t.lower.clone(),
                case_sensitive: t.case_sensitive,
            });
            let mut handles = Vec::with_capacity(n);
            for _ in 0..n {
                handles.push(thread::spawn({
                    let rx = rx.clone();
                    let rtx = rtx.clone();
                    let text = shared_text.clone();
                    let cancel = cancel.clone();
                    move || text_worker(rx, rtx, text, cancel)
                }));
            }
            (Some(tx), Some(rrx), handles)
        }
        None => (None, None, Vec::new()),
    };

    for entry in walkdir::WalkDir::new(&root).follow_links(false).min_depth(1) {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                push_error(&mut errors, e.to_string());
                continue;
            }
        };
        scanned += 1;
        let name = entry.file_name().to_string_lossy().to_string();
        if !matcher.matches(&name) {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        let Some(e) = build_entry(entry.path(), &md, name) else { continue };
        if let Some(from) = date_from {
            if e.mtime < from {
                continue;
            }
        }
        if let Some(to) = date_to {
            if e.mtime > to {
                continue;
            }
        }
        let hit = SearchHitDto {
            path: entry.path().to_string_lossy().to_string(),
            name: e.name,
            is_dir: e.is_dir,
            size: e.size,
            mtime: e.mtime,
            attrs: e.attrs,
            is_symlink: e.is_symlink,
            is_hidden: e.is_hidden,
        };
        if e.is_dir {
            // directories match by name only; a size or content condition
            // excludes them by nature
            if find_dirs && size_from.is_none() && size_to.is_none() && text.is_none() {
                hit_count += 1;
                buffer.push(hit);
            }
        } else {
            if let Some(min) = size_from {
                if e.size < min {
                    continue;
                }
            }
            if let Some(max) = size_to {
                if e.size > max {
                    continue;
                }
            }
            match &job_tx {
                Some(tx) => {
                    let _ = tx.send(TextJob { path: entry.path().to_path_buf(), hit });
                }
                None => {
                    hit_count += 1;
                    buffer.push(hit);
                }
            }
        }
        if let Some(rx) = &replies_rx {
            drain_replies(rx, &mut buffer, &mut hit_count, &mut errors);
        }
        if !buffer.is_empty()
            && (last_emit.elapsed().as_millis() >= EMIT_INTERVAL_MS || buffer.len() >= MAX_BUFFERED_HITS)
        {
            let hits = std::mem::take(&mut buffer);
            let _ = app.emit("search:hit", SearchHitsEvent { id, hits, scanned });
            last_emit = Instant::now();
        }
    }

    // walk done: close the job queue, let workers finish their in-flight
    // files, then take whatever replies are left
    drop(job_tx);
    for h in worker_handles {
        let _ = h.join();
    }
    if let Some(rx) = &replies_rx {
        drain_replies(rx, &mut buffer, &mut hit_count, &mut errors);
    }
    if cancel.load(Ordering::Relaxed) {
        cancelled = true;
    }
    if !buffer.is_empty() {
        let hits = std::mem::take(&mut buffer);
        let _ = app.emit("search:hit", SearchHitsEvent { id, hits, scanned });
    }
    let _ = app.emit(
        "search:done",
        SearchDoneEvent {
            id,
            cancelled,
            errors,
            scanned,
            hits: hit_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    );
    mgr.finish(id);
}

#[tauri::command]
pub fn search_start(
    app: AppHandle,
    state: tauri::State<'_, SearchManager>,
    params: SearchParams,
) -> Result<u32, String> {
    let root = PathBuf::from(params.root.trim());
    if root.as_os_str().is_empty() {
        return Err("empty search root".into());
    }
    let md = fs::metadata(&root).map_err(|e| format!("{}: {}", params.root, e))?;
    if !md.is_dir() {
        return Err(format!("not a directory: {}", params.root));
    }
    let matcher = if params.use_regex {
        let pattern = if params.mask.trim().is_empty() {
            ".*"
        } else {
            params.mask.trim()
        };
        Matcher::Regex(Regex::new(pattern).map_err(|e| format!("invalid regex: {}", e))?)
    } else {
        Matcher::Masks(compile_mask(&params.mask))
    };
    let text = params
        .text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|raw| SearchText {
            lower: raw.to_lowercase(),
            raw: raw.to_string(),
            case_sensitive: params.text_case_sensitive,
        });
    let (id, cancel) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    let (date_from, date_to, size_from, size_to, find_dirs) =
        (params.date_from, params.date_to, params.size_from, params.size_to, params.find_dirs);
    tauri::async_runtime::spawn_blocking(move || {
        run_search(app, mgr, id, cancel, root, matcher, text, date_from, date_to, size_from, size_to, find_dirs);
    });
    Ok(id)
}

#[tauri::command]
pub fn search_cancel(state: tauri::State<'_, SearchManager>, id: u32) -> Result<(), String> {
    let handles = state.inner.handles.lock().unwrap();
    match handles.get(&id) {
        Some(cancel) => {
            cancel.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("no such search".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(mask: &str, name: &str) -> bool {
        let patterns = compile_mask(mask);
        let lowered: Vec<char> = name.to_lowercase().chars().collect();
        patterns.iter().any(|p| match_pattern(p, &lowered))
    }

    #[test]
    fn mask_semantics_matches_frontend() {
        // empty mask = match everything
        assert!(m("", "anything.txt"));
        assert!(m("   ", "x"));
        // plain wildcard forms
        assert!(m("*.txt", "readme.TXT")); // case-insensitive
        assert!(!m("*.txt", "readme.md"));
        assert!(m("read?e", "readme"));
        assert!(!m("read?e", "readmde"));
        assert!(m("a*b*c", "aXbYc"));
        assert!(m("a*b*c", "a-b-b-b-c"));
        assert!(!m("a*b*c", "ab"));
        assert!(m("*", "любой"));
        // comma list = OR
        assert!(m("*.md, *.txt", "notes.md"));
        assert!(m("*.md,*.txt", "notes.txt"));
        assert!(!m("*.md,*.txt", "notes.rst"));
        // dots are literal (frontend escapes them)
        assert!(!m("a.b", "axb"));
        // unicode case folding
        assert!(m("ДОСЬЕ*", "досье-2026.txt"));
    }
}
