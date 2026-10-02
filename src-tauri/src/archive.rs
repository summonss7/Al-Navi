use crate::fs::{DirListing, EntryDto};
use crate::textio::{decode_content, HexChunk, TextContent};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

/// URL scheme of the archive VFS: `archive://C:\dir\a.zip/inner/path` —
/// everything before the first `/` is the archive file path (the frontend
/// normalizes it to `\` separators), the rest is the inner `/`-separated path.
pub const ARCHIVE_SCHEME: &str = "archive://";

/// Largest member loaded whole into memory by the viewer (text/hex), same
/// cap as the FTP text reader.
pub(crate) const MAX_MEMBER_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Zip,
    Tar,
    TarGz,
    SevenZ,
}

pub fn is_archive_url(s: &str) -> bool {
    s.starts_with(ARCHIVE_SCHEME)
}

pub fn parse_archive_url(url: &str) -> Result<(PathBuf, String), String> {
    let rest = url
        .strip_prefix(ARCHIVE_SCHEME)
        .ok_or_else(|| format!("not an archive url: {}", url))?;
    let (file, inner) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    if file.is_empty() {
        return Err(format!("bad archive url: {}", url));
    }
    Ok((PathBuf::from(file), normalize_inner(inner)))
}

/// Normalize an inner archive path to `/` separators, no leading/trailing
/// slash and no "./" prefix (zip/tar writers emit all kinds of forms).
pub(crate) fn normalize_inner(s: &str) -> String {
    let mut r = s.replace('\\', "/");
    while let Some(stripped) = r.strip_prefix("./") {
        r = stripped.to_string();
    }
    while r.starts_with('/') {
        r.remove(0);
    }
    while r.ends_with('/') {
        r.pop();
    }
    r
}

/// Detect the archive format: by supported extension first, then by magic
/// bytes (lets the user enter any real archive file regardless of its name).
pub fn detect_format(path: &Path) -> Option<Format> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        return Some(Format::TarGz);
    }
    if name.ends_with(".zip") {
        return Some(Format::Zip);
    }
    if name.ends_with(".tar") {
        return Some(Format::Tar);
    }
    if name.ends_with(".7z") {
        return Some(Format::SevenZ);
    }
    let mut f = File::open(path).ok()?;
    let mut head = [0u8; 262];
    let n = f.read(&mut head).unwrap_or(0);
    if n >= 4 && &head[..4] == b"PK\x03\x04" {
        return Some(Format::Zip);
    }
    if n >= 6 && &head[..6] == b"7z\xbc\xaf\x27\x1c" {
        return Some(Format::SevenZ);
    }
    if n >= 2 && head[0] == 0x1f && head[1] == 0x8b {
        return Some(Format::TarGz);
    }
    if n >= 262 && &head[257..262] == b"ustar" {
        return Some(Format::Tar);
    }
    None
}

// ---------- time helpers ----------

fn mtime_ms_of(md: &fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Windows FILETIME (100ns since 1601-01-01) -> unix milliseconds.
pub(crate) fn filetime_to_ms(ft: u64) -> i64 {
    const EPOCH_DIFF: u64 = 116_444_736_000_000_000;
    if ft <= EPOCH_DIFF {
        return 0;
    }
    ((ft - EPOCH_DIFF) / 10_000) as i64
}

/// Days from 1970-01-01 to y-m-d (Howard Hinnant's civil calendar algorithm).
pub(crate) fn days_from_civil(y: i64, m: u64, d: u64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64; // [0, 399]
    let mp = ((m + 9) % 12) as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Inverse of days_from_civil: (y, m, d) from days since epoch.
pub(crate) fn civil_from_days(z: i64) -> (i64, u64, u64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u64; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u64; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// DOS zip date-time -> unix milliseconds (None when out of the DOS range).
fn dos_to_epoch_ms(year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) -> Option<i64> {
    if !(1980..=2107).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year as i64, month as u64, day as u64);
    Some((days * 86400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64) * 1000)
}

/// Unix milliseconds -> DOS zip date-time components.
pub(crate) fn epoch_ms_to_dos(ms: i64) -> (u16, u8, u8, u8, u8, u8) {
    let secs = (ms / 1000).max(0);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let y = y.clamp(1980, 2107) as u16;
    (
        y,
        m as u8,
        d as u8,
        (rem / 3600) as u8,
        ((rem % 3600) / 60) as u8,
        (rem % 60) as u8,
    )
}

// ---------- zip entry-name decoding ----------

/// Zip entries written by DOS/Windows tools (WinRAR, FAR) store OEM names:
/// valid UTF-8 passes through, anything else is treated as cp866 — the
/// historical Russian zip code page (ASCII is identical in both).
pub(crate) fn decode_zip_name(raw: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    let (cow, _, _) = encoding_rs::IBM866.decode(raw);
    cow.into_owned()
}

// ---------- full listing (with cache) ----------

#[derive(Clone)]
pub struct ArcEntry {
    /// normalized inner path, `/`-separated, no trailing slash
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// unix epoch milliseconds
    pub mtime: i64,
}

struct CachedList {
    stamp: (i64, u64),
    entries: Arc<Vec<ArcEntry>>,
}

static LIST_CACHE: Mutex<Option<BTreeMap<PathBuf, CachedList>>> = Mutex::new(None);
const CACHE_MAX: usize = 8;

/// Read the complete entry list of an archive. Results are cached per file
/// and invalidated by (mtime, len) — tar.gz/7z headers are not re-parsed on
/// every panel refresh.
pub fn read_full_list(file: &Path) -> Result<Arc<Vec<ArcEntry>>, String> {
    let md = fs::metadata(file).map_err(|e| format!("{}: {}", file.display(), e))?;
    let stamp = (mtime_ms_of(&md), md.len());
    if let Some(map) = &*LIST_CACHE.lock().unwrap() {
        if let Some(c) = map.get(file) {
            if c.stamp == stamp {
                return Ok(c.entries.clone());
            }
        }
    }
    let entries = Arc::new(read_full_list_uncached(file, stamp.0)?);
    let mut guard = LIST_CACHE.lock().unwrap();
    let map = guard.get_or_insert_with(BTreeMap::new);
    if map.len() >= CACHE_MAX {
        map.clear();
    }
    map.insert(file.to_path_buf(), CachedList { stamp, entries: entries.clone() });
    Ok(entries)
}

fn read_full_list_uncached(file: &Path, fallback_mtime: i64) -> Result<Vec<ArcEntry>, String> {
    let fmt = detect_format(file)
        .ok_or_else(|| format!("not a supported archive: {}", file.display()))?;
    let mut have: BTreeMap<String, ArcEntry> = BTreeMap::new();
    match fmt {
        Format::Zip => {
            let f = File::open(file).map_err(|e| e.to_string())?;
            let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
            for i in 0..z.len() {
                let e = z.by_index_raw(i).map_err(|e| e.to_string())?;
                let name = normalize_inner(&decode_zip_name(e.name_raw()));
                if name.is_empty() || have.contains_key(&name) {
                    continue;
                }
                let is_dir = e.is_dir() || name.ends_with('/');
                let mtime = e
                    .last_modified()
                    .and_then(|dt| dos_to_epoch_ms(dt.year(), dt.month(), dt.day(), dt.hour(), dt.minute(), dt.second()))
                    .unwrap_or(fallback_mtime);
                have.insert(name.clone(), ArcEntry { name: name.clone(), is_dir, size: if is_dir { 0 } else { e.size() }, mtime });
            }
        }
        Format::Tar | Format::TarGz => {
            let f = File::open(file).map_err(|e| e.to_string())?;
            let input: Box<dyn Read> = if fmt == Format::TarGz {
                Box::new(flate2::read::GzDecoder::new(f))
            } else {
                Box::new(f)
            };
            let mut t = tar::Archive::new(input);
            for ent in t.entries().map_err(|e| e.to_string())? {
                let ent = ent.map_err(|e| e.to_string())?;
                let name = normalize_inner(&ent.path().unwrap_or_default().to_string_lossy());
                if name.is_empty() || have.contains_key(&name) {
                    continue;
                }
                let hdr = ent.header();
                let is_dir = hdr.entry_type().is_dir() || name.ends_with('/');
                let mtime = hdr.mtime().map(|s| s as i64 * 1000).unwrap_or(fallback_mtime);
                let size = if is_dir { 0 } else { hdr.size().unwrap_or(0) };
                have.insert(name.clone(), ArcEntry { name: name.clone(), is_dir, size, mtime });
            }
        }
        Format::SevenZ => {
            let r = sevenz_rust::SevenZReader::open(file, sevenz_rust::Password::empty())
                .map_err(|e| e.to_string())?;
            for fe in &r.archive().files {
                let name = normalize_inner(fe.name());
                if name.is_empty() || fe.is_anti_item() || have.contains_key(&name) {
                    continue;
                }
                let is_dir = fe.is_directory() || name.ends_with('/');
                let mtime = if fe.has_last_modified_date {
                    filetime_to_ms(u64::from(fe.last_modified_date))
                } else {
                    fallback_mtime
                };
                let size = if is_dir { 0 } else { fe.size() };
                have.insert(name.clone(), ArcEntry { name: name.clone(), is_dir, size, mtime });
            }
        }
    }
    // zip/tar archives may carry no directory records at all — synthesize the
    // intermediate dirs from file paths so the panel shows a real tree
    let mut synthetic: Vec<ArcEntry> = Vec::new();
    let mut seen: HashSet<String> = have.keys().cloned().collect();
    for e in have.values() {
        let mut acc = String::new();
        let segs: Vec<&str> = e.name.split('/').collect();
        for seg in &segs[..segs.len().saturating_sub(1)] {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            if !acc.is_empty() && seen.insert(acc.clone()) {
                synthetic.push(ArcEntry { name: acc.clone(), is_dir: true, size: 0, mtime: e.mtime });
            }
        }
    }
    for s in synthetic {
        have.insert(s.name.clone(), s);
    }
    Ok(have.into_values().collect())
}

// ---------- single-member reads (F3 viewer) ----------

/// Read one archive member into memory (capped), returning (bytes, full size).
pub fn read_entry_bytes(file: &Path, inner: &str, cap: u64) -> Result<(Vec<u8>, u64), String> {
    let fmt = detect_format(file)
        .ok_or_else(|| format!("not a supported archive: {}", file.display()))?;
    match fmt {
        Format::Zip => {
            let f = File::open(file).map_err(|e| e.to_string())?;
            let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
            for i in 0..z.len() {
                let mut e = z.by_index(i).map_err(|err| err.to_string())?;
                if normalize_inner(&decode_zip_name(e.name_raw())) != inner || e.is_dir() {
                    continue;
                }
                let size = e.size();
                let mut buf = Vec::with_capacity(size.min(cap) as usize);
                (&mut e).take(cap).read_to_end(&mut buf).map_err(|err| err.to_string())?;
                return Ok((buf, size));
            }
            Err(format!("entry not found: {}", inner))
        }
        Format::Tar | Format::TarGz => {
            let f = File::open(file).map_err(|e| e.to_string())?;
            let input: Box<dyn Read> = if fmt == Format::TarGz {
                Box::new(flate2::read::GzDecoder::new(f))
            } else {
                Box::new(f)
            };
            let mut t = tar::Archive::new(input);
            for ent in t.entries().map_err(|e| e.to_string())? {
                let mut ent = ent.map_err(|e| e.to_string())?;
                let name = normalize_inner(&ent.path().unwrap_or_default().to_string_lossy());
                if name != inner || ent.header().entry_type().is_dir() {
                    continue;
                }
                let size = ent.header().size().unwrap_or(0);
                let mut buf = Vec::with_capacity(size.min(cap) as usize);
                (&mut ent).take(cap).read_to_end(&mut buf).map_err(|e| e.to_string())?;
                return Ok((buf, size));
            }
            Err(format!("entry not found: {}", inner))
        }
        Format::SevenZ => {
            let mut r = sevenz_rust::SevenZReader::open(file, sevenz_rust::Password::empty())
                .map_err(|e| e.to_string())?;
            let target = inner.to_string();
            let mut res: Option<(Vec<u8>, u64)> = None;
            let mut io_err: Option<std::io::Error> = None;
            r.for_each_entries(|e, rd| {
                if res.is_none() && io_err.is_none() && normalize_inner(e.name()) == target && !e.is_directory() {
                    let size = e.size();
                    let mut buf = Vec::with_capacity(size.min(cap) as usize);
                    if let Err(err) = (&mut *rd).take(cap).read_to_end(&mut buf) {
                        io_err = Some(err);
                        return Ok(false);
                    }
                    res = Some((buf, size));
                    return Ok(false); // found — stop decoding
                }
                Ok(true)
            })
            .map_err(|e| e.to_string())?;
            if let Some(err) = io_err {
                return Err(err.to_string());
            }
            res.ok_or_else(|| format!("entry not found: {}", inner))
        }
    }
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn archive_list(path: String) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (file, inner) = parse_archive_url(&path)?;
        let list = read_full_list(&file)?;
        let prefix = if inner.is_empty() { String::new() } else { format!("{}/", inner) };
        let mut entries = Vec::new();
        for e in list.iter() {
            let tail = if prefix.is_empty() {
                e.name.as_str()
            } else {
                match e.name.strip_prefix(prefix.as_str()) {
                    Some(t) => t,
                    None => continue,
                }
            };
            if tail.is_empty() || tail.contains('/') {
                continue;
            }
            entries.push(EntryDto {
                name: tail.to_string(),
                is_dir: e.is_dir,
                size: e.size,
                mtime: e.mtime,
                attrs: String::new(),
                is_symlink: false,
                is_hidden: tail.starts_with('.'),
            });
        }
        Ok(DirListing { path, entries, free_bytes: 0, total_bytes: 0 })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn archive_read_text(
    path: String,
    encoding: Option<String>,
    fallback: Option<String>,
) -> Result<TextContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (file, inner) = parse_archive_url(&path)?;
        let (buf, size) = read_entry_bytes(&file, &inner, MAX_MEMBER_BYTES)?;
        decode_content(&buf, size, encoding.as_deref(), fallback.as_deref().unwrap_or("windows-1251"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn archive_read_hex(path: String, offset: u64, len: u32) -> Result<HexChunk, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (file, inner) = parse_archive_url(&path)?;
        let need = offset.saturating_add(len as u64);
        if need > MAX_MEMBER_BYTES {
            return Err("file is too large for the hex view inside an archive".into());
        }
        let (buf, size) = read_entry_bytes(&file, &inner, need)?;
        let start = (offset as usize).min(buf.len());
        let end = start.saturating_add(len as usize).min(buf.len());
        Ok(HexChunk { data: buf[start..end].to_vec(), file_size: size })
    })
    .await
    .map_err(|e| e.to_string())?
}
