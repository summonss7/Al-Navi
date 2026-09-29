use encoding_rs::Encoding;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

/// Maximum bytes loaded into the editor by default; larger files are truncated
/// (the user is warned on the frontend and can switch to hex view).
const MAX_TEXT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
pub struct TextContent {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String, // "crlf" | "lf" | "cr" | "mixed"
    pub size: u64,
    pub truncated: bool,
}

fn lookup_encoding(label: &str) -> Option<&'static Encoding> {
    match label.to_ascii_lowercase().as_str() {
        "utf-8" => Some(encoding_rs::UTF_8),
        "utf-16le" => Some(encoding_rs::UTF_16LE),
        "utf-16be" => Some(encoding_rs::UTF_16BE),
        "windows-1251" => Some(encoding_rs::WINDOWS_1251),
        "koi8-r" => Some(encoding_rs::KOI8_R),
        "cp866" | "ibm866" => Some(encoding_rs::IBM866),
        "iso-8859-5" => Some(encoding_rs::ISO_8859_5),
        _ => Encoding::for_label(label.as_bytes()),
    }
}

fn detect_eol(s: &str) -> &'static str {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    crlf += 1;
                    i += 1;
                } else {
                    cr += 1;
                }
            }
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    match (crlf > 0, lf > 0, cr > 0) {
        (true, false, false) => "crlf",
        (false, true, false) => "lf",
        (false, false, true) => "cr",
        _ => "mixed",
    }
}

/// Detection order (FAR-like):
/// 1. BOM: UTF-8 / UTF-16LE / UTF-16BE
/// 2. Strict UTF-8 over the whole (loaded) prefix
/// 3. Heuristic: many NUL bytes → UTF-16 without BOM
/// 4. Fallback single-byte encoding (default windows-1251, configurable from UI)
fn decode_auto(bytes: &[u8], fallback: &str) -> (String, &'static str, bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _, _) = encoding_rs::UTF_8.decode(&bytes[3..]);
        return (cow.into_owned(), "utf-8", true);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (cow.into_owned(), "utf-16le", true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return (cow.into_owned(), "utf-16be", true);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return (String::from_utf8_lossy(bytes).into_owned(), "utf-8", false);
    }
    // crude UTF-16 heuristic: NUL in every second position of the first 64 bytes
    let n = bytes.len().min(64);
    if n >= 8 {
        let even_nul = bytes[..n].iter().skip(0).step_by(2).filter(|b| **b == 0).count();
        let odd_nul = bytes[..n].iter().skip(1).step_by(2).filter(|b| **b == 0).count();
        if even_nul > n / 3 {
            let (cow, _, _) = encoding_rs::UTF_16BE.decode(bytes);
            return (cow.into_owned(), "utf-16be", false);
        }
        if odd_nul > n / 3 {
            let (cow, _, _) = encoding_rs::UTF_16LE.decode(bytes);
            return (cow.into_owned(), "utf-16le", false);
        }
    }
    let enc = lookup_encoding(fallback).unwrap_or(encoding_rs::WINDOWS_1251);
    let (cow, _, _) = enc.decode(bytes);
    (cow.into_owned(), enc.name(), false)
}

#[tauri::command]
pub async fn read_text(
    path: String,
    encoding: Option<String>, // None = auto-detect; Some("auto") too
    fallback: Option<String>,
) -> Result<TextContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("{}: {}", path, e))?;
        let size = meta.len();
        let truncated = size > MAX_TEXT_BYTES;
        let mut f = fs::File::open(&path).map_err(|e| format!("{}: {}", path, e))?;
        let take = if truncated { MAX_TEXT_BYTES } else { size } as usize;
        let mut buf = Vec::with_capacity(take);
        let mut limited = (&mut f).take(take as u64);
        limited
            .read_to_end(&mut buf)
            .map_err(|e| format!("{}: {}", path, e))?;
        let (text, enc, bom) = match encoding.as_deref() {
            Some(label) if !label.eq_ignore_ascii_case("auto") => {
                let e = lookup_encoding(label)
                    .ok_or_else(|| format!("unknown encoding: {}", label))?;
                if label.eq_ignore_ascii_case("utf-8") && buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
                    let (cow, _, _) = e.decode(&buf[3..]);
                    (cow.into_owned(), "utf-8", true)
                } else {
                    let (cow, _, _) = e.decode(&buf);
                    (cow.into_owned(), e.name(), false)
                }
            }
            _ => decode_auto(&buf, fallback.as_deref().unwrap_or("windows-1251")),
        };
        let eol = detect_eol(&text);
        Ok(TextContent {
            text,
            encoding: enc.to_string(),
            bom,
            eol: eol.to_string(),
            size,
            truncated,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_text(
    path: String,
    content: String,
    encoding: String,
    eol: String, // "crlf" | "lf" | "cr" | "keep"
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = if eol == "keep" {
            content
        } else {
            let mut s = content.replace("\r\n", "\n").replace('\r', "\n");
            if eol == "crlf" {
                s = s.replace('\n', "\r\n");
            } else if eol == "cr" {
                s = s.replace('\n', "\r");
            }
            s
        };
        let enc = lookup_encoding(&encoding)
            .ok_or_else(|| format!("unknown encoding: {}", encoding))?;
        let bytes = if enc == encoding_rs::UTF_8 {
            // no BOM by default on save (FAR-like)
            text.as_bytes().to_vec()
        } else {
            let (cow, _, _) = enc.encode(&text);
            cow.into_owned()
        };
        let p = PathBuf::from(&path);
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let mut f = fs::File::create(&path).map_err(|e| format!("{}: {}", path, e))?;
        f.write_all(&bytes).map_err(|e| format!("{}: {}", path, e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexChunk {
    pub data: Vec<u8>,
    pub file_size: u64,
}

#[tauri::command]
pub async fn read_hex(path: String, offset: u64, len: u32) -> Result<HexChunk, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Seek;
        let mut f = fs::File::open(&path).map_err(|e| format!("{}: {}", path, e))?;
        let size = f.metadata().map_err(|e| e.to_string())?.len();
        f.seek(std::io::SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; len as usize];
        let mut read_total = 0usize;
        loop {
            match f.read(&mut buf[read_total..]) {
                Ok(0) => break,
                Ok(n) => {
                    read_total += n;
                    if read_total == buf.len() {
                        break;
                    }
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        buf.truncate(read_total);
        Ok(HexChunk { data: buf, file_size: size })
    })
    .await
    .map_err(|e| e.to_string())?
}
