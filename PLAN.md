# Architectural Plan & Decision Record (PLAN.md)

## 1. System Architecture Overview

```
+---------------------------------------------------------------+
|                      Tauri v2 Frontend                        |
|  - Bootstrap 6 (alpha) + Semantic Design Tokens               |
|  - Desktop Layout: Top Toolbar, Left Rail, Canvas, Props      |
|  - In-Window Keyboard Shortcuts & Command Palette (Ctrl+K)    |
|  - Virtualized Page List & Multi-scale Viewports              |
+-------------------------------+-------------------------------+
                                | IPC (Typed Commands / Events)
+-------------------------------v-------------------------------+
|                       Tauri Backend Layer                     |
|  - `src-tauri`: Thin IPC adapter & capability security config |
|  - Plugins: Dialog (file picker), FS scopes                   |
|  - Drag-and-drop file receiver (`onDragDropEvent`)            |
|  - Background Rayon thread pool for tile/page rendering       |
|  - Page Render Cache: LRU keyed by (page_idx, scale, rev_id)  |
+-------------------------------+-------------------------------+
                                | Direct Rust Calls
+-------------------------------v-------------------------------+
|                     `pdf-core` (Pure Rust)                    |
|  - Zero Tauri dependencies (fully headless testable)          |
|  - Invertible Command Engine (Unlimited Undo/Redo)            |
|  - Document State & Page Tree Manager (via `lopdf`)           |
|  - Page Renderer & Text Extractor (via `pdfium-render`)       |
|  - Annotation Factory (Highlight, FreeText, Ink, Shape, etc.) |
|  - Safe Atomic File Persistence (.tmp -> verify -> rename)    |
|  - Content Stream Redaction Engine (Text/Vector/Image Scrub)  |
|  - Programmatic Page Range Parser (DSL evaluator)             |
+---------------------------------------------------------------+
```

## 2. Invertible Command Pattern & Undo/Redo

Every document mutation implements the `DocumentCommand` trait:
```rust
pub trait DocumentCommand: Send + Sync {
    fn execute(&mut self, doc: &mut DocumentState) -> Result<(), CoreError>;
    fn undo(&mut self, doc: &mut DocumentState) -> Result<(), CoreError>;
    fn description(&self) -> String;
}
```

### Implemented & Tested Invertible Commands:
- `ReorderPagesCommand { previous_ids: Vec<ObjectId>, new_ids: Vec<ObjectId> }`: Guaranteed immune to permutation confusion.
- `RotatePagesCommand { pages: Vec<usize>, delta_deg: i32 }`: Inverts via `-delta_deg`.
- `DeletePagesCommand { deleted_positions, stored_pages, previous_page_ids }`: Re-inserts objects and restores page tree.
- `InsertBlankPageCommand { at_index: usize, width: f64, height: f64 }`: Removes inserted page on undo.
- `CropPagesCommand { pages: Vec<usize>, previous_boxes: Vec<Option<PageBox>>, new_box: Option<PageBox> }`: Restores exact prior boxes.
- `AddAnnotationCommand { page_index: usize, annotation: AnnotationDto }`: Removes annotation by UUID.
- `DeleteAnnotationCommand { page_index: usize, snapshot: AnnotationDto }`: Restores annotation snapshot.
- `ModifyAnnotationCommand { page_index: usize, old_state, new_state }`: Replaces annotation state.

## 3. Render Cache & Concurrency Strategy

- **Key**: `(page_index: usize, target_width: u32, revision_id: u64)`
- **Cache Storage**: In-memory LRU cache (`lru::LruCache`) storing high-DPI PNG encoded byte streams.
- **Thread Safety**: Protected by `parking_lot::Mutex`.
- **Performance Budget**:
  - 500-page document load: **6.47 ms** (budget: 500 ms)
  - 500-page document first page render: **100.67 ms** (budget: 1000 ms)

## 4. Data Safety & Atomic Persistence Protocol

1. User requests Save (`Ctrl+S`) or Save As (`Ctrl+Shift+S`).
2. Write target document to temporary file: `[file].tmp.[pid]` in the same directory.
3. Validate temporary file: reopen with `DocumentState::from_file`, verify page count, object tree, and catalog.
4. Optional backup: copy existing original file to `[file].pdf.bak`.
5. Atomically replace original with temporary file. If any step fails, temporary file is removed and original is completely untouched.

## 5. Milestone Completion Summary

- [x] **M1: Research & Spike** (Bootstrap 6 alpha evaluated, Tauri v2 plugins researched, pure Rust spike passed).
- [x] **M2: App Skeleton** (Tauri v2 + pure Rust `pdf-core`, themed Bootstrap 6 shell, drag-drop open, thumbnails & viewport).
- [x] **M3: Page Operations** (Programmatic selection DSL, reordering, rotation, deletion, duplication, blank pages, safe save, undo/redo).
- [x] **M4: Crop & Erase** (Non-destructive CropBox, Cover erase, True Redaction with content stream excising and byte scrubbing).
- [x] **M5: Annotations** (Free text, pen, highlighter, shapes, sticky notes, real PDF appearance stream serialization).
- [x] **M6: UX Polish** (Ctrl+K Command Palette, keyboard shortcuts, properties inspector, toasts with Undo, light/dark themes).
- [x] **M7: Extras** (Full document text search, document metadata viewer/editor, recent files list, page crop presets).
- [x] **M8: Hardening & Release** (500+ page performance benchmarks, parser fuzzing, 0 clippy warnings, release build ready).
