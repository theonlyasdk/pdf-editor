# Implemented Features

A running log of implemented features and their primary entry points in the codebase.

## Quality-of-Life & Workflow Features (2026-11-26)

- **Drop & Paste Any Image onto a Page**
  - Drag-and-drop PNG/JPEG files onto any page (via Tauri `onDragDropEvent` or DOM drop) or paste images from the clipboard (`Ctrl+V` / `Cmd+V`).
  - Automatically rasterizes and bounds the image into a PDF-space rectangle on the target page using `add_image_annotation`.
  - Files: `src/components/imageDropPaste.ts`, `src/components/SignatureModal.ts`, `src/main.ts`, `src-tauri/src/commands.rs` (`read_image_data_url`).

- **Logical Page Labels (`/PageLabels`)**
  - Parses PDF `/PageLabels` number trees (`Nums` / `Kids`, `/S` styles `D`, `R`, `r`, `A`, `a`, `/P` prefixes, and `/St` start numbers).
  - Displays logical labels (e.g. `i`, `ii`, `A-1`) in the thumbnail rail, annotation sidebar badges, and status bar, and supports jumping by either logical label or physical page number.
  - Files: `crates/pdf-core/src/document.rs` (`get_page_labels`), `crates/pdf-core/src/types.rs` (`PageInfo.label`), `src/components/ThumbnailRail.ts`, `src/components/SidebarTabs.ts`, `src/main.ts`.

- **Annotation Export / Summary (Markdown & CSV)**
  - Export all (or currently filtered) annotations and sticky notes from the Annotations sidebar tab as Markdown (`.md`) or RFC 4180 CSV (`.csv`), preserving logical page labels, authors, timestamps, and colors.
  - Files: `src/components/annotationExport.ts`, `src/components/SidebarTabs.ts`.

- **Session Restore & Crash Recovery**
  - Persists last opened file, scroll position (`scrollTop`, `scrollLeft`), current page, zoom / fit mode, and active sidebar tab in `localStorage` (`pdf_editor_session`) and restores them when reopening the document.
  - Periodically snapshots dirty document state every 15 seconds to the app data `recovery/` directory (`recovery.pdf` + `recovery.json`), prompts to recover unsaved edits after an unexpected exit, and clears recovery files on save or clean exit.
  - Files: `src/state/editorState.ts`, `src/components/CanvasView.ts`, `src/main.ts`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`.

- **OS File Association & CLI Arg Launch**
  - Registers `.pdf` file association in the Tauri bundle config and opens `pdf-editor.exe path/to/file.pdf` passed on the command line at startup.
  - Files: `src-tauri/tauri.conf.json`, `src-tauri/src/commands.rs` (`extract_launch_file_from_args`, `consume_launch_file`), `src-tauri/src/lib.rs`, `src/main.ts`.
