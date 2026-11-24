pub mod commands;

use commands::AppState;
use parking_lot::Mutex;
use std::sync::Arc;

pub fn run() {
    let initial_state = Arc::new(Mutex::new(AppState::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(initial_state)
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
            commands::detect_crop_margins,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
