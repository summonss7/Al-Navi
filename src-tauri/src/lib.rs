mod archive;
mod archive_ops;
mod config;
mod drives;
mod fs;
mod ftp;
mod ftp_ops;
mod locks;
mod meta;
mod ops;
mod search;
mod textio;
mod watch;
mod winstate;

// MinGW shim: the statically linked WebView2LoaderStatic.lib (MSVC-compiled)
// references MSVC CRT stack-protection and C++-runtime symbols that mingw
// does not provide. Defining them here satisfies the linker.
#[no_mangle]
#[used]
pub static mut __security_cookie: u64 = 0x2B99_2DDF_A232;
#[no_mangle]
pub extern "C" fn __security_check_cookie(_cookie: u64) {}
#[no_mangle]
pub extern "C" fn __security_check_cookie_fail() {}

unsafe extern "C" {
    fn malloc(size: usize) -> *mut u8;
    fn free(p: *mut u8);
}

/// MSVC `void operator delete(void*, unsigned __int64)`
#[export_name = "??3@YAXPEAX_K@Z"]
pub unsafe extern "C" fn msvc_sized_delete(p: *mut u8, _sz: u64) {
    free(p);
}

/// MSVC `void* operator new(unsigned __int64)`
#[export_name = "??2@YAPEAX_K@Z"]
pub unsafe extern "C" fn msvc_new(sz: u64) -> *mut u8 {
    malloc(sz as usize)
}

/// MSVC `void* operator new(unsigned __int64, std::nothrow_t const&)`
#[export_name = "??2@YAPEAX_KAEBUnothrow_t@std@@@Z"]
pub unsafe extern "C" fn msvc_new_nothrow(sz: u64, _nt: *const u8) -> *mut u8 {
    malloc(sz as usize)
}

/// MSVC `void* operator new[](unsigned __int64)`
#[export_name = "??_U@YAPEAX_K@Z"]
pub unsafe extern "C" fn msvc_new_array(sz: u64) -> *mut u8 {
    malloc(sz as usize)
}

/// MSVC `void operator delete[](void*)`
#[export_name = "??_V@YAXPEAX@Z"]
pub unsafe extern "C" fn msvc_delete_array(p: *mut u8) {
    free(p);
}

/// MSVC `std::nothrow_t const std::nothrow` (empty struct object)
#[export_name = "?nothrow@std@@3Unothrow_t@1@B"]
#[used]
pub static STD_NOTHROW: u8 = 0;

/// MSVC thread-safe static initialization guards. Simplified single-thread
/// emulation: header tells the caller to run init while epoch is unset,
/// footer marks it done. WebView2Loader only uses this for lazy function
/// pointers during early startup, so this is sufficient.
#[export_name = "_Init_thread_header"]
pub unsafe extern "C" fn init_thread_header(epoch: *mut i32) -> i32 {
    if *epoch == -1 {
        1
    } else {
        0
    }
}
#[export_name = "_Init_thread_footer"]
pub unsafe extern "C" fn init_thread_footer(epoch: *mut i32, _frame: *mut u8) {
    *epoch = 0;
}
#[no_mangle]
#[used]
pub static mut _Init_thread_epoch: i32 = -1;

pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .manage(ops::OpManager::new())
        .manage(watch::WatchState::new())
        .manage(ftp::FtpState::new())
        .manage(search::SearchManager::new())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                // the window starts hidden (tauri.conf.json) — restore the
                // remembered size/position/maximized first, then reveal it
                winstate::restore_and_show(&win);
                // Windows/WebView2: without this the webview lacks keyboard focus
                // on startup, so arrow keys/F-keys do nothing until first click
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::list_dir,
            fs::dir_sizes,
            fs::free_space,
            fs::mkdir,
            fs::path_exists,
            fs::parent_dir,
            fs::home_path,
            fs::open_path,
            fs::run_shell,
            fs::set_attributes,
            textio::read_text,
            textio::write_text,
            textio::read_hex,
            ops::copy_paths,
            ops::move_paths,
            ops::delete_paths,
            ops::rename_path,
            ops::rename_paths,
            ops::op_control,
            ops::resolve_conflict,
            drives::drives_list,
            watch::watch_set,
            ftp::ftp_connect,
            ftp::ftp_list,
            ftp::ftp_read_text,
            ftp::ftp_write_text,
            ftp::ftp_read_hex,
            ftp::ftp_mkdir,
            ftp::ftp_rename,
            config::load_json,
            config::save_json,
            archive::archive_list,
            archive::archive_read_text,
            archive::archive_read_hex,
            archive_ops::extract_paths,
            archive_ops::pack_paths,
            archive_ops::archive_add,
            search::search_start,
            search::search_cancel,
            meta::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Al-Navi");
}
