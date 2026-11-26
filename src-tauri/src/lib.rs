pub mod commands;
pub mod worker_pool;

use commands::{extract_launch_file_from_args, AppState, LaunchFileState, SharedState};
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WindowEvent};

pub fn run_render_worker() {
    worker_pool::run_render_worker();
}

fn cleanup_app_state(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<SharedState>() {
        state.lock().clear_for_exit();
    }
    commands::clear_recovery_files(app_handle);
}

pub fn run() {
    let initial_state = Arc::new(Mutex::new(AppState::new()));
    let launch_file = LaunchFileState(Mutex::new(extract_launch_file_from_args(
        std::env::args_os(),
    )));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(initial_state)
        .manage(launch_file)
        .invoke_handler(tauri::generate_handler![
            commands::open_document,
            commands::new_document,
            commands::render_page,
            commands::reorder_pages,
            commands::rotate_pages,
            commands::crop_pages,
            commands::delete_pages,
            commands::duplicate_pages,
            commands::insert_blank_page,
            commands::add_annotation,
            commands::delete_annotation,
            commands::cover_erase,
            commands::true_redact,
            commands::undo,
            commands::redo,
            commands::save_document,
            commands::save_document_as,
            commands::evaluate_range,
            commands::search_document,
            commands::get_document_state,
            commands::update_annotation,
            commands::update_metadata,
            commands::strip_metadata,
            commands::merge_pdf,
            commands::extract_pages,
            commands::export_pages_as_images,
            commands::apply_area_redactions,
            commands::add_image_annotation,
            commands::apply_watermark_or_page_numbers,
            commands::get_document_outline,
            commands::update_document_outline,
            commands::get_page_text_spans,
            commands::get_page_links,
            commands::get_form_fields,
            commands::set_form_field_value,
            commands::flatten_form_fields,
            commands::detect_crop_margins,
            commands::reveal_in_folder,
            commands::rename_document,
            commands::open_external_url,
            commands::consume_launch_file,
            commands::read_image_data_url,
            commands::snapshot_recovery_state,
            commands::check_recovery_state,
            commands::restore_recovery_state,
            commands::discard_recovery_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } => {
            let no_other_windows = app_handle
                .webview_windows()
                .keys()
                .all(|k| k == &label);
            if no_other_windows {
                cleanup_app_state(app_handle);
                app_handle.exit(0);
            }
        }
        RunEvent::Exit => {
            cleanup_app_state(app_handle);
        }
        _ => {}
    });

    std::process::exit(0);
}
