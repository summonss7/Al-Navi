use encoding_rs::Encoding;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

/// Maximum bytes loaded into the editor by default; larger files are truncated
/// (the user is warned on the frontend and can switch to hex view).
pub(crate) const MAX_TEXT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
pub struct TextContent {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String, // "crlf" | "lf" | "cr" | "mixed"
    pub size: u64,
    pub truncated: bool,
}

pub(crate) fn lookup_encoding(label: &str) -> Option<&'static Encoding> {
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

/// Canonical lowercase id reported to the frontend (Encoding::name() would
/// return WHATWG spellings like "UTF-8" / "IBM866"; the UI menus and the
/// status select expect "utf-8" / "cp866").
pub(crate) fn canon_label(e: &'static Encoding) -> &'static str {
    if e == encoding_rs::UTF_8 {
        "utf-8"
    } else if e == encoding_rs::UTF_16LE {
        "utf-16le"
    } else if e == encoding_rs::UTF_16BE {
        "utf-16be"
    } else if e == encoding_rs::WINDOWS_1251 {
        "windows-1251"
    } else if e == encoding_rs::KOI8_R {
        "koi8-r"
    } else if e == encoding_rs::IBM866 {
        "cp866"
    } else if e == encoding_rs::ISO_8859_5 {
        "iso-8859-5"
    } else {
        e.name()
    }
}

pub(crate) fn detect_eol(s: &str) -> &'static str {
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
pub(crate) fn decode_auto(bytes: &[u8], fallback: &str) -> (String, &'static str, bool) {
    // BOMs are handled here explicitly, so the actual decodes must not
    // BOM-sniff again (Encoding::decode() would override the choice)
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _) = encoding_rs::UTF_8.decode_without_bom_handling(&bytes[3..]);
        return (cow.into_owned(), "utf-8", true);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(&bytes[2..]);
        return (cow.into_owned(), "utf-16le", true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(&bytes[2..]);
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
            let (cow, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(bytes);
            return (cow.into_owned(), "utf-16be", false);
        }
        if odd_nul > n / 3 {
            let (cow, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(bytes);
            return (cow.into_owned(), "utf-16le", false);
        }
    }
    let enc = lookup_encoding(fallback).unwrap_or(encoding_rs::WINDOWS_1251);
    let (cow, _) = enc.decode_without_bom_handling(bytes);
    (cow.into_owned(), canon_label(enc), false)
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
        decode_content(&buf, size, encoding.as_deref(), fallback.as_deref().unwrap_or("windows-1251"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shared decode step of read_text (also used by the FTP reader).
pub(crate) fn decode_content(
    buf: &[u8],
    size: u64,
    encoding: Option<&str>,
    fallback: &str,
) -> Result<TextContent, String> {
    let truncated = size > MAX_TEXT_BYTES;
    let (text, enc, bom) = match encoding {
        Some(label) if !label.eq_ignore_ascii_case("auto") => {
            let e = lookup_encoding(label).ok_or_else(|| format!("unknown encoding: {}", label))?;
            // An explicit choice must win: Encoding::decode() sniffs a UTF-8/16
            // BOM and silently overrides the requested encoding, so a manual
            // switch on a BOM'd file used to return the text unchanged
            // (alnavi-037). Only a BOM of the very encoding the user picked
            // is consumed (FAR-like: picking UTF-8 on a UTF-8-BOM file must
            // not show the BOM as text).
            if e == encoding_rs::UTF_8 && buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
                let (cow, _) = e.decode_without_bom_handling(&buf[3..]);
                (cow.into_owned(), "utf-8", true)
            } else if e == encoding_rs::UTF_16LE && buf.starts_with(&[0xFF, 0xFE]) {
                let (cow, _) = e.decode_without_bom_handling(&buf[2..]);
                (cow.into_owned(), "utf-16le", true)
            } else if e == encoding_rs::UTF_16BE && buf.starts_with(&[0xFE, 0xFF]) {
                let (cow, _) = e.decode_without_bom_handling(&buf[2..]);
                (cow.into_owned(), "utf-16be", true)
            } else {
                let (cow, _) = e.decode_without_bom_handling(buf);
                (cow.into_owned(), canon_label(e), false)
            }
        }
        _ => decode_auto(buf, fallback),
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
}

/// Shared encode step of write_text (also used by the FTP writer).
pub(crate) fn encode_text(content: String, encoding: &str, eol: &str) -> Result<Vec<u8>, String> {
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
    let enc = lookup_encoding(encoding).ok_or_else(|| format!("unknown encoding: {}", encoding))?;
    let bytes = if enc == encoding_rs::UTF_8 {
        // no BOM by default on save (FAR-like)
        text.as_bytes().to_vec()
    } else if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        // WHATWG quirk: Encoding::encode() defines the UTF-16 encoder to be
        // the UTF-8 encoder (web legacy), so UTF_16LE.encode() silently
        // returns UTF-8 bytes — spell the real UTF-16 bytes out instead.
        // A BOM is written (Notepad/FAR-like): without it Cyrillic UTF-16
        // has no NUL bytes for the auto-detector's heuristic and the file
        // would re-open as 1251 mojibake.
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut out = Vec::with_capacity(units.len() * 2 + 2);
        out.extend_from_slice(if enc == encoding_rs::UTF_16LE {
            &[0xFF, 0xFE]
        } else {
            &[0xFE, 0xFF]
        });
        for u in units {
            if enc == encoding_rs::UTF_16LE {
                out.extend_from_slice(&u.to_le_bytes());
            } else {
                out.extend_from_slice(&u.to_be_bytes());
            }
        }
        out
    } else {
        let (cow, _, _) = enc.encode(&text);
        cow.into_owned()
    };
    Ok(bytes)
}

#[tauri::command]
pub async fn write_text(
    path: String,
    content: String,
    encoding: String,
    eol: String, // "crlf" | "lf" | "cr" | "keep"
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = encode_text(content, &encoding, &eol)?;
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
