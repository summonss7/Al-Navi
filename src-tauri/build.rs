use std::time::{SystemTime, UNIX_EPOCH};

/// Embed the build timestamp into the binary as AL_NAVI_BUILD_TIME
/// (civil-from-days algorithm, no external crates).
fn main() {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };

    println!(
        "cargo:rustc-env=AL_NAVI_BUILD_TIME={:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        y, mo, d, h, m, s
    );

    // On the GNU toolchain webview2-com links WebView2Loader.dll dynamically.
    // src-tauri/lib/libWebView2Loader.dll.a is a copy of WebView2LoaderStatic.lib:
    // by naming it like the import-lib search candidate it makes the loader link
    // statically, so the release exe needs no DLL beside it.
    let lib_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("lib");
    if lib_dir.join("libWebView2Loader.dll.a").exists() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
    }

    tauri_build::build()
}
