use crate::archive::{self, read_full_list, ArcEntry, Format};
use crate::ops::{auto_rename, emit_done, new_ctx, walk_stats, Ctx, OpError, OpHandle, OpManager};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

const CHUNK: usize = 1024 * 1024;

/// A reader that drives op progress (and pause/cancel) while the archive
/// writer consumes it — every format's write path copies through a Read.
struct ProgressReader<'c, R> {
    inner: R,
    label: String,
    ctx: &'c mut Ctx,
}

impl<R: Read> Read for ProgressReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.ctx.check_pause_cancel() {
            return Err(io::Error::other("cancelled"));
        }
        let n = self.inner.read(buf)?;
        self.ctx.bytes_done += n as u64;
        self.ctx.progress("transfer", &self.label);
        Ok(n)
    }
}

fn cancelled() -> io::Error {
    io::Error::other("cancelled")
}

fn set_mtime(dst: &Path, mtime_ms: i64) {
    let ft = filetime::FileTime::from_unix_time(mtime_ms.div_euclid(1000), mtime_ms.rem_euclid(1000) as u32 * 1_000_000);
    let _ = filetime::set_file_times(dst, ft, ft);
}

fn fs_mtime_ms(p: &Path) -> i64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Format-neutral "write into an archive" surface shared by packing and by
/// appending into an existing archive.
trait ArcSink {
    fn add_file(&mut self, fs_path: &Path, arc_name: &str, ctx: &mut Ctx) -> Result<(), String>;
    fn add_dir(&mut self, fs_path: &Path, arc_name: &str) -> Result<(), String>;
    fn finish(self: Box<Self>) -> Result<(), String>;
}

fn zip_opts(mtime_ms: i64) -> zip::write::SimpleFileOptions {
    let (y, mo, d, h, mi, s) = archive::epoch_ms_to_dos(mtime_ms);
    let dt = zip::DateTime::from_date_and_time(y, mo, d, h, mi, s)
        .unwrap_or_else(|_| zip::DateTime::default());
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true)
        .last_modified_time(dt)
}

impl ArcSink for zip::ZipWriter<File> {
    fn add_file(&mut self, fs_path: &Path, arc_name: &str, ctx: &mut Ctx) -> Result<(), String> {
        let mut f = File::open(fs_path).map_err(|e| format!("{}: {}", fs_path.display(), e))?;
        self.start_file(arc_name.replace('\\', "/"), zip_opts(fs_mtime_ms(fs_path)))
            .map_err(|e| e.to_string())?;
        let mut pr = ProgressReader { inner: &mut f, label: fs_path.to_string_lossy().to_string(), ctx };
        io::copy(&mut pr, self).map_err(|e| e.to_string())?;
        Ok(())
    }
    fn add_dir(&mut self, _fs_path: &Path, arc_name: &str) -> Result<(), String> {
        let mut name = arc_name.replace('\\', "/");
        name.push('/');
        self.add_directory(name, zip::write::SimpleFileOptions::default())
            .map_err(|e| e.to_string())
    }
    fn finish(self: Box<Self>) -> Result<(), String> {
        (*self).finish().map(|_| ()).map_err(|e| e.to_string())
    }
}

fn tar_header(arc_name: &str, fs_path: &Path, mtime_ms: i64, is_dir: bool, size: u64) -> tar::Header {
    let mut h = tar::Header::new_gnu();
    let _ = h.set_path(arc_name.replace('\\', "/"));
    let mode = if is_dir { 0o755 } else { 0o644 };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(md) = fs::metadata(fs_path) {
            h.set_mode(md.mode());
        } else {
            h.set_mode(mode);
        }
    }
    #[cfg(not(unix))]
    let _ = fs::metadata(fs_path);
    #[cfg(not(unix))]
    h.set_mode(mode);
    h.set_mtime(mtime_ms.div_euclid(1000).max(0) as u64);
    h.set_size(size);
    h.set_entry_type(if is_dir { tar::EntryType::Directory } else { tar::EntryType::Regular });
    h.set_cksum();
    h
}

impl ArcSink for tar::Builder<Box<dyn Write>> {
    fn add_file(&mut self, fs_path: &Path, arc_name: &str, ctx: &mut Ctx) -> Result<(), String> {
        let size = fs::metadata(fs_path).map(|m| m.len()).unwrap_or(0);
        let mut f = File::open(fs_path).map_err(|e| format!("{}: {}", fs_path.display(), e))?;
        let mut h = tar_header(arc_name, fs_path, fs_mtime_ms(fs_path), false, size);
        let mut pr = ProgressReader { inner: &mut f, label: fs_path.to_string_lossy().to_string(), ctx };
        self.append(&mut h, &mut pr).map_err(|e| e.to_string())
    }
    fn add_dir(&mut self, fs_path: &Path, arc_name: &str) -> Result<(), String> {
        let mut h = tar_header(arc_name, fs_path, fs_mtime_ms(fs_path), true, 0);
        let mut empty = io::empty();
        self.append(&mut h, &mut empty).map_err(|e| e.to_string())
    }
    fn finish(mut self: Box<Self>) -> Result<(), String> {
        (*self).finish().map_err(|e| e.to_string())
    }
}

impl ArcSink for sevenz_rust::SevenZWriter<File> {
    fn add_file(&mut self, fs_path: &Path, arc_name: &str, ctx: &mut Ctx) -> Result<(), String> {
        let entry = sevenz_rust::SevenZArchiveEntry::from_path(fs_path, arc_name.replace('\\', "/"));
        let mut f = File::open(fs_path).map_err(|e| format!("{}: {}", fs_path.display(), e))?;
        let mut pr = ProgressReader { inner: &mut f, label: fs_path.to_string_lossy().to_string(), ctx };
        self.push_archive_entry(entry, Some(&mut pr)).map(|_| ()).map_err(|e| e.to_string())
    }
    fn add_dir(&mut self, fs_path: &Path, arc_name: &str) -> Result<(), String> {
        let entry = sevenz_rust::SevenZArchiveEntry::from_path(fs_path, arc_name.replace('\\', "/"));
        self.push_archive_entry::<io::Empty>(entry, None).map(|_| ()).map_err(|e| e.to_string())
    }
    fn finish(self: Box<Self>) -> Result<(), String> {
        (*self).finish().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Recursively add a filesystem path under `arc_prefix` ("/"-terminated or
/// empty) into any sink, walking children in name order.
fn add_path_rec<S: ArcSink + ?Sized>(sink: &mut S, p: &Path, arc_prefix: &str, ctx: &mut Ctx) -> Result<(), String> {
    if ctx.check_pause_cancel() {
        return Err("cancelled".into());
    }
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if name.is_empty() {
        return Ok(());
    }
    let arc_name = format!("{}{}", arc_prefix, name);
    if p.is_dir() {
        sink.add_dir(p, &arc_name)?;
        let mut kids: Vec<PathBuf> = fs::read_dir(p)
            .map_err(|e| format!("{}: {}", p.display(), e))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        kids.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
        let sub_prefix = format!("{}/", arc_name);
        for k in kids {
            add_path_rec(sink, &k, &sub_prefix, ctx)?;
        }
    } else {
        sink.add_file(p, &arc_name, ctx)?;
        ctx.files_done += 1;
    }
    Ok(())
}

/// Add one source with an already-unique archive name (used by append-into-
/// archive where the top-level name may have been auto-renamed).
fn add_named<S: ArcSink + ?Sized>(sink: &mut S, src: &Path, arc_name: &str, ctx: &mut Ctx) -> Result<(), String> {
    if src.is_dir() {
        sink.add_dir(src, arc_name)?;
        let mut kids: Vec<PathBuf> = fs::read_dir(src)
            .map_err(|e| format!("{}: {}", src.display(), e))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        kids.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
        let prefix = format!("{}/", arc_name);
        for k in kids {
            add_path_rec(sink, &k, &prefix, ctx)?;
        }
        Ok(())
    } else {
        sink.add_file(src, arc_name, ctx)?;
        ctx.files_done += 1;
        Ok(())
    }
}

fn make_sink(fmt: Format, tmp: &Path) -> Result<Box<dyn ArcSink>, String> {
    match fmt {
        Format::Zip => {
            let f = File::create(tmp).map_err(|e| e.to_string())?;
            Ok(Box::new(zip::ZipWriter::new(f)))
        }
        Format::Tar => {
            let f = Box::new(File::create(tmp).map_err(|e| e.to_string())?) as Box<dyn Write>;
            Ok(Box::new(tar::Builder::new(f)))
        }
        Format::TarGz => {
            let f = File::create(tmp).map_err(|e| e.to_string())?;
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            Ok(Box::new(tar::Builder::new(Box::new(gz) as Box<dyn Write>)))
        }
        Format::SevenZ => {
            let w = sevenz_rust::SevenZWriter::create(tmp).map_err(|e| e.to_string())?;
            Ok(Box::new(w))
        }
    }
}

fn parse_pack_format(s: &str) -> Result<Format, String> {
    match s {
        "zip" => Ok(Format::Zip),
        "tar" => Ok(Format::Tar),
        "targz" => Ok(Format::TarGz),
        "7z" => Ok(Format::SevenZ),
        other => Err(format!("unknown archive format: {}", other)),
    }
}

// ---------- Alt+F6 / F5-from-archive-panel: extraction ----------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractItem {
    /// archive:// member url or a plain archive file path
    pub url: String,
    /// target directory for this item (per-archive subfolders)
    pub dest: String,
}

#[tauri::command]
pub fn extract_paths(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    items: Vec<ExtractItem>,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_extract(app, mgr, id, h, items);
    });
    Ok(id)
}

/// Selection: a plain archive file path extracts the whole archive, an
/// `archive://` url extracts that member (a dir member takes its subtree).
fn selected(e: &ArcEntry, inners: &[String]) -> bool {
    inners.iter().any(|sel| sel.is_empty() || e.name == *sel || e.name.starts_with(&format!("{}/", sel)))
}

fn write_member_file(dst: &Path, rd: &mut dyn Read, size: u64, mtime_ms: i64, ctx: &mut Ctx, label: &str) -> io::Result<()> {
    // a member can land in a dest that doesn't exist yet (a typed path, or an
    // archive without dir records) — create the chain on demand
    if let Some(par) = dst.parent() {
        fs::create_dir_all(par)?;
    }
    crate::ops::ensure_writable(dst);
    let mut outf = File::create(dst)?;
    let mut buf = vec![0u8; CHUNK];
    let mut left = size;
    while left > 0 {
        if ctx.check_pause_cancel() {
            return Err(cancelled());
        }
        let want = buf.len().min(left as usize);
        let mut got = 0usize;
        while got < want {
            match rd.read(&mut buf[got..want]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(e) => return Err(e),
            }
        }
        if got == 0 {
            break; // short entry — keep what arrived
        }
        outf.write_all(&buf[..got])?;
        left -= got as u64;
        ctx.bytes_done += got as u64;
        ctx.progress("transfer", label);
    }
    set_mtime(dst, mtime_ms);
    Ok(())
}

/// Extract one conflicting destination: ask, then overwrite / skip / rename.
fn resolve_member_conflict(ctx: &mut Ctx, member: &str, dst: &Path) -> Option<PathBuf> {
    if !dst.exists() {
        return Some(dst.to_path_buf());
    }
    match ctx.ask_conflict(Path::new(member), dst, false).as_str() {
        "skip" => None,
        "rename" => Some(auto_rename(dst)),
        _ => Some(dst.to_path_buf()),
    }
}

fn member_error(ctx: &mut Ctx, member: &str, e: String) {
    if e == "cancelled" {
        ctx.cancelled = true;
    } else {
        ctx.errors.push(OpError { path: member.to_string(), error: e });
    }
}

fn run_extract(app: AppHandle, mgr: OpManager, id: u32, h: Arc<OpHandle>, items: Vec<ExtractItem>) {
    let mut ctx = new_ctx(app, id, h);

    // group selections by archive file, preserving the given order
    let mut groups: Vec<(PathBuf, Vec<String>, String, PathBuf)> = Vec::new(); // (file, inners, label, dest)
    for it in &items {
        let (file, inner) = if archive::is_archive_url(&it.url) {
            match archive::parse_archive_url(&it.url) {
                Ok(v) => v,
                Err(e) => {
                    ctx.errors.push(OpError { path: it.url.clone(), error: e });
                    continue;
                }
            }
        } else {
            (PathBuf::from(&it.url), String::new())
        };
        match groups.iter_mut().find(|(f, _, _, _)| *f == file) {
            Some((_, inners, _, _)) => inners.push(inner),
            None => groups.push((file, vec![inner], it.url.clone(), PathBuf::from(&it.dest))),
        }
    }

    // prescan from the (cached) listings — no decompression needed
    ctx.progress("scan", "");
    let mut plans: Vec<(PathBuf, Format, Vec<ArcEntry>, PathBuf)> = Vec::new();
    for (file, inners, label, dest) in &groups {
        if ctx.check_pause_cancel() {
            break;
        }
        match archive::detect_format(file) {
            Some(fmt) => match read_full_list(file) {
                Ok(list) => {
                    let hits: Vec<ArcEntry> = list.iter().filter(|e| selected(e, inners)).cloned().collect();
                    if hits.is_empty() {
                        ctx.errors.push(OpError { path: label.clone(), error: "nothing selected".into() });
                        continue;
                    }
                    ctx.bytes_total += hits.iter().filter(|e| !e.is_dir).map(|e| e.size).sum::<u64>();
                    ctx.files_total += hits.iter().filter(|e| !e.is_dir).count() as u64;
                    plans.push((file.clone(), fmt, hits, dest.clone()));
                }
                Err(e) => ctx.errors.push(OpError { path: label.clone(), error: e }),
            },
            None => ctx.errors.push(OpError { path: label.clone(), error: "not a supported archive".into() }),
        }
    }

    for (file, fmt, hits, dest) in &plans {
        if ctx.cancelled || ctx.check_pause_cancel() {
            break;
        }
        // make the selected empty dirs real too
        for e in hits.iter().filter(|e| e.is_dir) {
            let _ = fs::create_dir_all(dest.join(&e.name));
        }
        let res = match fmt {
            Format::Zip => extract_zip(file, hits, dest, &mut ctx),
            Format::Tar | Format::TarGz => extract_tar(*fmt, file, hits, dest, &mut ctx),
            Format::SevenZ => extract_7z(file, hits, dest, &mut ctx),
        };
        if let Err(e) = res {
            if e == "cancelled" {
                ctx.cancelled = true;
                break;
            }
            ctx.errors.push(OpError { path: file.to_string_lossy().to_string(), error: e });
        }
    }
    emit_done(&ctx);
    mgr.finish(id);
}

fn extract_zip(file: &Path, hits: &[ArcEntry], dest: &Path, ctx: &mut Ctx) -> Result<(), String> {
    let f = File::open(file).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    // member name (decoded like the listing does) -> zip index
    let mut index: HashMap<String, usize> = HashMap::new();
    for i in 0..z.len() {
        let e = z.by_index_raw(i).map_err(|e| e.to_string())?;
        index.insert(archive::decode_zip_name(e.name_raw()), i);
    }
    for hit in hits {
        if ctx.cancelled || ctx.check_pause_cancel() {
            return Err("cancelled".into());
        }
        if hit.is_dir {
            continue;
        }
        let dst = dest.join(&hit.name);
        let Some(real_dst) = resolve_member_conflict(ctx, &hit.name, &dst) else {
            ctx.bytes_done += hit.size;
            ctx.files_done += 1;
            continue;
        };
        let Some(&i) = index.get(&hit.name) else {
            member_error(ctx, &hit.name, "entry not found".into());
            continue;
        };
        let mut e = z.by_index(i).map_err(|err| err.to_string())?;
        if let Err(err) = write_member_file(&real_dst, &mut e, hit.size, hit.mtime, ctx, &hit.name) {
            let msg = err.to_string();
            member_error(ctx, &hit.name, msg);
            let _ = fs::remove_file(&real_dst);
            continue;
        }
        ctx.files_done += 1;
    }
    Ok(())
}

fn extract_tar(fmt: Format, file: &Path, hits: &[ArcEntry], dest: &Path, ctx: &mut Ctx) -> Result<(), String> {
    let wanted: HashSet<&str> = hits.iter().map(|e| e.name.as_str()).collect();
    let f = File::open(file).map_err(|e| e.to_string())?;
    let input: Box<dyn Read> = if fmt == Format::TarGz {
        Box::new(flate2::read::GzDecoder::new(f))
    } else {
        Box::new(f)
    };
    let mut t = tar::Archive::new(input);
    for ent in t.entries().map_err(|e| e.to_string())? {
        if ctx.cancelled || ctx.check_pause_cancel() {
            return Err("cancelled".into());
        }
        let mut ent = ent.map_err(|e| e.to_string())?;
        let name = archive::normalize_inner(&ent.path().unwrap_or_default().to_string_lossy());
        if !wanted.contains(name.as_str()) || name.is_empty() {
            continue; // the iterator skips the unread data itself
        }
        if ent.header().entry_type().is_dir() {
            let _ = fs::create_dir_all(dest.join(&name));
            continue;
        }
        let size = ent.header().size().unwrap_or(0);
        let mtime = ent.header().mtime().map(|s| s as i64 * 1000).unwrap_or(0);
        let dst = dest.join(&name);
        let Some(real_dst) = resolve_member_conflict(ctx, &name, &dst) else {
            ctx.bytes_done += size;
            ctx.files_done += 1;
            continue;
        };
        if let Err(err) = write_member_file(&real_dst, &mut ent, size, mtime, ctx, &name) {
            let msg = err.to_string();
            member_error(ctx, &name, msg);
            let _ = fs::remove_file(&real_dst);
            continue;
        }
        ctx.files_done += 1;
    }
    Ok(())
}

fn extract_7z(file: &Path, hits: &[ArcEntry], dest: &Path, ctx: &mut Ctx) -> Result<(), String> {
    let wanted: HashSet<String> = hits.iter().map(|e| e.name.clone()).collect();
    let mut r = sevenz_rust::SevenZReader::open(file, sevenz_rust::Password::empty())
        .map_err(|e| e.to_string())?;
    let mut failure: Option<String> = None;
    r.for_each_entries(|e, rd| {
        if failure.is_some() || ctx.cancelled || ctx.check_pause_cancel() {
            return Ok(false);
        }
        let name = archive::normalize_inner(e.name());
        if !wanted.contains(&name) || name.is_empty() || e.is_directory() {
            return Ok(true);
        }
        let size = e.size();
        let mtime = if e.has_last_modified_date {
            archive::filetime_to_ms(u64::from(e.last_modified_date))
        } else {
            0
        };
        let dst = dest.join(&name);
        match resolve_member_conflict(ctx, &name, &dst) {
            None => {
                ctx.bytes_done += size;
                ctx.files_done += 1;
            }
            Some(real_dst) => {
                if let Err(err) = write_member_file(&real_dst, rd, size, mtime, ctx, &name) {
                    let msg = err.to_string();
                    if msg == "cancelled" {
                        ctx.cancelled = true;
                        failure = Some(msg);
                    } else {
                        ctx.errors.push(OpError { path: name.clone(), error: msg });
                    }
                    let _ = fs::remove_file(&real_dst);
                } else {
                    ctx.files_done += 1;
                }
            }
        }
        Ok(true)
    })
    .map_err(|e| e.to_string())?;
    match failure {
        Some(msg) => Err(msg),
        None => Ok(()),
    }
}

// ---------- Alt+F5: packing ----------

#[tauri::command]
pub fn pack_paths(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    paths: Vec<String>,
    dest_file: String,
    format: String,
) -> Result<u32, String> {
    let fmt = parse_pack_format(&format)?;
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_pack(app, mgr, id, h, paths, dest_file, fmt);
    });
    Ok(id)
}

fn tmp_sibling(dest: &Path) -> PathBuf {
    dest.parent()
        .unwrap_or(Path::new("."))
        .join(format!(".alnavi-pack-{}.tmp", std::process::id()))
}

fn run_pack(app: AppHandle, mgr: OpManager, id: u32, h: Arc<OpHandle>, paths: Vec<String>, dest_file: String, fmt: Format) {
    let mut ctx = new_ctx(app, id, h);
    let mut dest = PathBuf::from(&dest_file);
    if dest.exists() {
        match ctx.ask_conflict(Path::new(&dest_file), &dest, false).as_str() {
            "skip" => {
                emit_done(&ctx);
                mgr.finish(id);
                return;
            }
            "rename" => dest = auto_rename(&dest),
            _ => {
                crate::ops::ensure_writable(&dest);
                let _ = fs::remove_file(&dest);
            }
        }
    }
    if let Some(par) = dest.parent() {
        let _ = fs::create_dir_all(par);
    }

    ctx.progress("scan", "");
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let (bytes, files) = walk_stats(srcs.iter().map(|p| p.as_path()));
    ctx.bytes_total = bytes;
    ctx.files_total = files;

    let tmp = tmp_sibling(&dest);
    let mut sink = match make_sink(fmt, &tmp) {
        Ok(s) => s,
        Err(e) => {
            ctx.errors.push(OpError { path: dest_file.clone(), error: e });
            emit_done(&ctx);
            mgr.finish(id);
            return;
        }
    };
    let mut ok = true;
    for src in &srcs {
        if let Err(e) = add_path_rec(sink.as_mut(), src, "", &mut ctx) {
            if e == "cancelled" {
                ctx.cancelled = true;
            } else {
                ctx.errors.push(OpError { path: src.to_string_lossy().to_string(), error: e });
            }
            ok = false;
            break;
        }
    }
    finish_sink(&mut ctx, &dest, &tmp, sink, ok);
    emit_done(&ctx);
    mgr.finish(id);
}

/// Shared tail of pack/append: close the writer, publish the temp file on a
/// clean run, drop it otherwise.
fn finish_sink(ctx: &mut Ctx, dest: &Path, tmp: &Path, sink: Box<dyn ArcSink>, ok: bool) {
    match sink.finish() {
        Ok(()) => {
            if ok && !ctx.cancelled {
                if let Err(e) = fs::rename(tmp, dest) {
                    ctx.errors.push(OpError { path: dest.to_string_lossy().to_string(), error: e.to_string() });
                    let _ = fs::remove_file(tmp);
                }
            } else {
                let _ = fs::remove_file(tmp);
            }
        }
        Err(e) => {
            ctx.errors.push(OpError { path: dest.to_string_lossy().to_string(), error: e });
            let _ = fs::remove_file(tmp);
        }
    }
}

// ---------- F5/F6 into an archive panel: append into an existing archive ----------

#[tauri::command]
pub fn archive_add(
    app: AppHandle,
    state: tauri::State<'_, OpManager>,
    srcs: Vec<String>,
    dest_url: String,
    move_mode: bool,
) -> Result<u32, String> {
    let (id, h) = state.register();
    let mgr = (*state).clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_add(app, mgr, id, h, srcs, dest_url, move_mode);
    });
    Ok(id)
}

/// "name.ext" -> "name (1).ext", bumping until not present in `taken`.
fn unique_arc_name(name: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for i in 1..u32::MAX {
        let cand = format!("{} ({}){}", stem, i, ext);
        if !taken.contains(&cand) {
            return cand;
        }
    }
    format!("{} (dup)", name)
}

fn run_add(app: AppHandle, mgr: OpManager, id: u32, h: Arc<OpHandle>, srcs: Vec<String>, dest_url: String, move_mode: bool) {
    let mut ctx = new_ctx(app, id, h);
    let Ok((file, inner)) = archive::parse_archive_url(&dest_url) else {
        ctx.errors.push(OpError { path: dest_url.clone(), error: "bad archive url".into() });
        emit_done(&ctx);
        mgr.finish(id);
        return;
    };
    let Some(fmt) = archive::detect_format(&file) else {
        ctx.errors.push(OpError { path: dest_url.clone(), error: format!("not a supported archive: {}", file.display()) });
        emit_done(&ctx);
        mgr.finish(id);
        return;
    };
    let src_paths: Vec<PathBuf> = srcs.iter().map(PathBuf::from).collect();
    if src_paths.iter().any(|p| crate::ops::same_path(p, &file)) {
        ctx.errors.push(OpError { path: dest_url.clone(), error: "cannot add an archive into itself".into() });
        emit_done(&ctx);
        mgr.finish(id);
        return;
    }

    ctx.progress("scan", "");
    let Ok(old) = read_full_list(&file) else {
        ctx.errors.push(OpError { path: dest_url.clone(), error: "cannot read the archive".into() });
        emit_done(&ctx);
        mgr.finish(id);
        return;
    };
    let mut names: HashSet<String> = old.iter().map(|e| e.name.clone()).collect();
    // planned new entries: (fs path, unique archive name at the target dir)
    let prefix = if inner.is_empty() { String::new() } else { format!("{}/", inner) };
    let mut planned: Vec<(PathBuf, String)> = Vec::new();
    for src in &src_paths {
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let full = unique_arc_name(&format!("{}{}", prefix, name), &names);
        collect_arc_names(&mut names, src, &format!("{}/", full));
        planned.push((src.clone(), full));
    }

    let (new_bytes, new_files) = walk_stats(src_paths.iter().map(|p| p.as_path()));
    let old_bytes: u64 = old.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
    ctx.bytes_total = old_bytes + new_bytes;
    ctx.files_total = old.iter().filter(|e| !e.is_dir).count() as u64 + new_files;

    let tmp = tmp_sibling(&file);
    let rewrite = match fmt {
        Format::Zip => rewrite_zip(&file, &tmp, &mut ctx),
        Format::Tar | Format::TarGz => rewrite_tar(fmt, &file, &tmp, &mut ctx),
        Format::SevenZ => rewrite_7z(&file, &tmp, &mut ctx),
    };
    let mut sink = match rewrite {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            ctx.errors.push(OpError { path: dest_url.clone(), error: e });
            emit_done(&ctx);
            mgr.finish(id);
            return;
        }
    };

    let mut ok = true;
    for (src, arc_name) in &planned {
        if let Err(e) = add_named(sink.as_mut(), src, arc_name, &mut ctx) {
            if e == "cancelled" {
                ctx.cancelled = true;
            } else {
                ctx.errors.push(OpError { path: src.to_string_lossy().to_string(), error: e });
            }
            ok = false;
            break;
        }
    }
    finish_sink(&mut ctx, &file, &tmp, sink, ok);

    // move semantics: sources were archived — remove them (after a clean rename)
    if move_mode && ok && !ctx.cancelled && ctx.errors.is_empty() && file.exists() {
        for (src, _) in &planned {
            let res = if src.is_dir() {
                fs::remove_dir_all(src).map_err(|e| e.to_string())
            } else {
                crate::ops::ensure_writable(src);
                fs::remove_file(src).map_err(|e| e.to_string())
            };
            if let Err(e) = res {
                ctx.errors.push(OpError { path: src.to_string_lossy().to_string(), error: e });
            }
        }
    }
    emit_done(&ctx);
    mgr.finish(id);
}

/// Pre-register every name the tree under `src` will occupy, so parallel new
/// entries never collide inside one rewrite.
fn collect_arc_names(names: &mut HashSet<String>, src: &Path, prefix: &str) {
    for e in walkdir::WalkDir::new(src).follow_links(false) {
        let Ok(e) = e else { continue };
        let base = e.path().strip_prefix(src).unwrap_or(e.path());
        if base.as_os_str().is_empty() {
            continue;
        }
        names.insert(format!("{}{}", prefix, base.to_string_lossy().replace('\\', "/")));
    }
}

/// zip: copy all old entries without decompressing (raw local headers), then
/// the caller appends the new ones through the same ZipWriter.
fn rewrite_zip(file: &Path, tmp: &Path, ctx: &mut Ctx) -> Result<Box<dyn ArcSink>, String> {
    let old_f = File::open(file).map_err(|e| e.to_string())?;
    let mut old = zip::ZipArchive::new(old_f).map_err(|e| e.to_string())?;
    let out = File::create(tmp).map_err(|e| e.to_string())?;
    let mut w = zip::ZipWriter::new(out);
    for i in 0..old.len() {
        if ctx.check_pause_cancel() {
            return Err("cancelled".into());
        }
        let e = old.by_index(i).map_err(|err| err.to_string())?;
        let name = archive::decode_zip_name(e.name_raw());
        let size = if e.is_dir() { 0 } else { e.size() };
        w.raw_copy_file(e).map_err(|err| err.to_string())?;
        // raw copy is a fast metadata+bytes move — count the entry at once
        ctx.bytes_done += size;
        ctx.files_done += 1;
        ctx.progress("transfer", &name);
    }
    Ok(Box::new(w))
}

fn rewrite_tar(fmt: Format, file: &Path, tmp: &Path, ctx: &mut Ctx) -> Result<Box<dyn ArcSink>, String> {
    let f = File::open(file).map_err(|e| e.to_string())?;
    let input: Box<dyn Read> = if fmt == Format::TarGz {
        Box::new(flate2::read::GzDecoder::new(f))
    } else {
        Box::new(f)
    };
    let out: Box<dyn Write> = if fmt == Format::TarGz {
        let raw = File::create(tmp).map_err(|e| e.to_string())?;
        Box::new(flate2::write::GzEncoder::new(raw, flate2::Compression::default()))
    } else {
        Box::new(File::create(tmp).map_err(|e| e.to_string())?)
    };
    let mut old = tar::Archive::new(input);
    let mut b = tar::Builder::new(out);
    for ent in old.entries().map_err(|e| e.to_string())? {
        if ctx.check_pause_cancel() {
            return Err("cancelled".into());
        }
        let mut ent = ent.map_err(|e| e.to_string())?;
        let name = archive::normalize_inner(&ent.path().unwrap_or_default().to_string_lossy());
        let is_dir = ent.header().entry_type().is_dir();
        let mut hdr = ent.header().clone();
        let mut pr = ProgressReader { inner: &mut ent, label: name, ctx };
        b.append(&mut hdr, &mut pr).map_err(|e| e.to_string())?;
        if !is_dir {
            ctx.files_done += 1;
        }
    }
    Ok(Box::new(b))
}

fn rewrite_7z(file: &Path, tmp: &Path, ctx: &mut Ctx) -> Result<Box<dyn ArcSink>, String> {
    let mut old = sevenz_rust::SevenZReader::open(file, sevenz_rust::Password::empty())
        .map_err(|e| e.to_string())?;
    let mut w = sevenz_rust::SevenZWriter::create(tmp).map_err(|e| e.to_string())?;
    old.for_each_entries(|e, rd| {
        if ctx.check_pause_cancel() {
            return Ok(false);
        }
        let entry = e.clone();
        let is_dir = e.is_directory();
        let label = e.name().to_string();
        let mut pr = ProgressReader { inner: rd, label, ctx: &mut *ctx };
        w.push_archive_entry(entry, Some(&mut pr))?;
        if !is_dir {
            ctx.files_done += 1;
        }
        Ok(true)
    })
    .map_err(|e| e.to_string())?;
    Ok(Box::new(w))
}
