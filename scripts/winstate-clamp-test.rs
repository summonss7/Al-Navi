// Standalone check of the winstate.rs clamp logic (cargo test is broken in
// this env — see README; the fn below is a byte-copy of clamped_size plus
// the MIN_SAVED_* degenerate floor from src-tauri/src/winstate.rs).
// Usage: rustc +stable-x86_64-pc-windows-gnu scripts/winstate-clamp-test.rs -o %TEMP%\wst.exe && run
const MIN_SAVED_W: u32 = 200;
const MIN_SAVED_H: u32 = 150;

fn clamped_size(w: u32, h: u32, scale: f64, max_w: u32, max_h: u32) -> (u32, u32) {
    let w = w.max((940.0 * scale) as u32).min(max_w);
    let h = h.max((560.0 * scale) as u32).min(max_h);
    (w, h)
}

fn degenerate(w: u32, h: u32) -> bool {
    w < MIN_SAVED_W || h < MIN_SAVED_H
}

fn main() {
    let mut fails = 0;
    let mut case = |name: &str, ok: bool, got: String| {
        println!("{}  {}  {}", if ok { "PASS" } else { "FAIL" }, name, got);
        if !ok {
            fails += 1;
        }
    };

    // the parked minimized record (181×24) is rejected outright
    case("minimized record degenerate", degenerate(181, 24), format!("{},{}", 181, 24));
    case("normal record not degenerate", !degenerate(940, 560) && !degenerate(1100, 700), "940x560 / 1100x700".into());

    let (w, h) = clamped_size(1100, 700, 1.0, 1920, 1080);
    case("normal size untouched", (w, h) == (1100, 700), format!("{w}x{h}"));

    let (w, h) = clamped_size(940, 560, 1.0, 1920, 1080);
    case("app minimum kept at scale 1.0", (w, h) == (940, 560), format!("{w}x{h}"));

    let (w, h) = clamped_size(2560, 1440, 1.0, 1920, 1080);
    case("oversize capped to monitor", (w, h) == (1920, 1080), format!("{w}x{h}"));

    let (w, h) = clamped_size(1000, 600, 1.5, 3840, 2160);
    case("scale 1.5 lifts to logical min", (w, h) == (1410, 840), format!("{w}x{h}"));

    let (w, h) = clamped_size(1000, 600, 1.5, 1280, 720);
    case("monitor cap wins over lift", (w, h) == (1280, 720), format!("{w}x{h}"));

    let (w, h) = clamped_size(1200, 800, 0.8, 1920, 1080);
    case("sub-1.0 scale clamped to 1.0", (w, h) == (1200, 800), format!("{w}x{h}"));

    let (w, h) = clamped_size(950, 600, 1.0, u32::MAX, u32::MAX);
    case("unknown monitors: no cap", (w, h) == (950, 600), format!("{w}x{h}"));

    if fails > 0 {
        std::process::exit(1);
    }
}
