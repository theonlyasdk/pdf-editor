#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--render-worker")) {
        pdf_editor_lib::run_render_worker();
        return;
    }
    pdf_editor_lib::run();
}
