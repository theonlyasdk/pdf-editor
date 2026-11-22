# PDF Editor Technology Research & Evaluation

## 1. Bootstrap 6 (alpha) Investigation

### Current State & Availability
- **Official Version**: `bootstrap@6.0.0-alpha.1` (tagged `next` on npm, published October 2026).
- **Official Repository**: [twbs/bootstrap Releases](https://github.com/twbs/bootstrap/releases)
- **Official Documentation**: [getbootstrap.com](https://getbootstrap.com/)
- **Installation Verification**: Successfully installed and verified via `npm install bootstrap@6.0.0-alpha.1 @floating-ui/dom`.

### What Changed from Bootstrap 5.x
1. **Color & Design Token System**:
   - Built on modern CSS color standards: `oklch()` color space and `color-mix()` functions.
   - Example token definitions: `--bs-blue-500: oklch(60% 0.24 240deg);` and tints generated via `color-mix(in oklch, var(--bs-white) 80%, oklch(60% 0.24 240deg))`.
   - Replaced fragmented Sass color variables with unified CSS token maps.
2. **Build System & Sass Modules**:
   - Fully migrated from legacy `@import` to modern Dart Sass modules (`@use` and `@forward`).
   - Scoped imports eliminate global variable namespace pollution.
3. **100% ESM JavaScript Architecture**:
   - Dropped legacy UMD bundles. JavaScript is distributed purely as ES modules (`type="module"`).
   - Replaced `@popperjs/core` with modern `@floating-ui/dom`.
   - Authoring in TypeScript with strict typings.
4. **Modern Browser Baseline**:
   - Raised browser floor: Chrome/Edge 130+, Firefox 132+, Safari 18+.
   - Native support for CSS `:has()`, `container queries`, `light-dark()`, and standard HTML `<dialog>` elements for modals.
5. **Tailwind-Aligned Utility Prefix Syntax**:
   - Responsive utilities switched from infix format (e.g., `.d-md-none`) to modern prefix syntax (e.g., `.md:d-none`).

### Integration Decision
- We pin and use `bootstrap@6.0.0-alpha.1` directly.
- We layer our custom application design tokens (neutral desktop utility palette, single accent `#2563eb`, semantic alerts, 4/8/12/16/24 spacing scale) cleanly on top of Bootstrap 6's CSS custom property foundation.

---

## 2. Tauri v2 Architecture & Ecosystem

### Core Capabilities & Permissions
- Tauri v2 replaces the legacy `tauri.conf.json` allowlist with an explicit capability and permission system defined in `src-tauri/capabilities/*.json`.
- Key permission identifiers required for our desktop PDF editor:
  - `core:default`: App lifecycle, event emitter, window management.
  - `dialog:default`: Native file picker dialogs (`open`, `save`).
  - `fs:default` (and specific read/write path scopes): Low-level file system access.
  - Window drag-and-drop: `dragDropEnabled: true` in window definition.

### File Drop & Event Handling
- Tauri v2 provides `getCurrentWebview().onDragDropEvent()` emitting `enter`, `over`, `drop`, and `leave` payloads.
- Dropped paths are received directly as absolute file paths on the host OS (`windows`, `macos`, `linux`), allowing the pure Rust core backend to open memory-mapped file handles instantly without serializing large base64 strings across the IPC bridge.

### Command Execution & Background Processing
- Tauri v2's `#[tauri::command]` functions run asynchronously in a Tokio / Rayon thread pool.
- Background page rendering with thread-safe caching avoids ever blocking the UI thread.
- Fast binary transfers: Can stream rendered page image buffers (RGBA or WebP/PNG) directly to the webview.

---

## 3. Rust PDF Stack: Comparative Evaluation

We evaluated four primary engines for rendering and document manipulation:

| Criterion | `pdfium-render` (Google PDFium) | `lopdf` (Pure Rust) | `mupdf` bindings | `pdf.js` (Mozilla) |
| :--- | :--- | :--- | :--- | :--- |
| **Engine Source** | Chromium PDFium (C++) via Rust wrapper | 100% Pure Rust | Artifex MuPDF (C) | JavaScript / WASM |
| **License** | Apache-2.0 / BSD-3 (Permissive) | MIT (Permissive) | AGPLv3 (Strict copyleft risk) | Apache-2.0 (Permissive) |
| **Raster Rendering** | High-speed, SIMD, Skia-backed | **None** (Cannot rasterize) | Fast, high quality | Fast in browser Canvas |
| **Structure Editing** | High-level (limited stream surgery) | **Exceptional** (full object graph) | Good | Limited (client-side) |
| **True Redaction** | Visual annotation only | Full content stream operator parsing & byte scrubbing | High-level API | N/A |
| **Binary Size** | ~7.8 MB dynamic library (`pdfium.dll`) | < 2 MB static compiled | 30-50 MB native libs | ~5 MB JS/WASM bundle |
| **Large Files (500+ pgs)**| Excellent (page on-demand) | Fast stream parser | Fast | High memory overhead in DOM |
| **Encrypted PDFs** | Full standard support (RC4, AES) | Basic encryption support | Full support | Full support |
| **Boxes & Rotation** | CropBox, MediaBox, TrimBox, 0/90/180/270 | Full dictionary access | Full support | Full support |

### The Chosen Hybrid Architecture: `lopdf` + `pdfium-render`
To achieve maximum speed, zero UI freezes, and true PDF specification compliance:
1. **Rendering & Fast Text Extraction**: `pdfium-render` (using prebuilt binary `pdfium.dll` on Windows / libpdfium on Linux/macOS). Renders anti-aliased pages at arbitrary DPI (thumbnails at 0.2x scale, viewport at 1.0x-2.0x scale) in background Rayon threads.
2. **Lossless Structure Editing & Content Surgery**: `lopdf` pure Rust engine. Manipulates the page tree (`/Pages`, `/Kids`), rotates pages (`/Rotate`), adjusts non-destructive boxes (`/CropBox`, `/MediaBox`), manages annotation arrays (`/Annots`), and surgically rewrites page content streams for **True Redaction**.
3. **Pure Rust Core Separation**: The `pdf-core` crate encapsulates all operations with zero Tauri dependencies. It exposes clean, invertible commands (`Command` trait with `execute` and `undo`).

---

## 4. True Redaction Research

### Why "Cover" is NOT Redaction
Drawing a black or white filled rectangle (`/Subtype /Square` or a graphics operator `re f`) only paints over pixels in the rasterizer. The underlying text operators (`Tj`, `TJ`, `'`, `"`), glyph encodings, and vector objects remain in the content stream. Any user can:
1. Select and copy the text underneath the box in Adobe Acrobat, Apple Preview, or Chrome.
2. Extract the text using `pdftotext`, `pdfium`, or Python scripts.
3. Search for the sensitive keywords in the raw file bytes.

### The Two-Phase True Redaction Protocol
1. **Phase 1: Content Stream Surgery**:
   - Decompress the target page's `/Contents` stream (`FlateDecode`).
   - Parse the content stream into individual PDF operators (`lopdf::content::Content`).
   - Identify text operators whose glyph positions intersect the redaction bounding box (pt coordinates).
   - Excise the matching text glyphs / strings completely from the operator arguments.
   - For image objects (`Do`), compute if an image is fully covered and scrub the XObject reference, or tile-mask the underlying raster pixels.
2. **Phase 2: Visual Obscuration & Sanitization**:
   - Inject a permanent solid fill rectangle (`0 0 0 rg ... re f`) in the content stream so the redacted region is visually blacked out in all viewers.
   - Re-encode the sanitized content stream.
   - Force a non-incremental rebuild of the cross-reference table (`xref`) to purge old revisions and orphaned streams from the physical PDF file.
3. **Verification**:
   - Text extraction test: Assert extracted text from the page no longer contains the redacted string.
   - Raw bytes test: Assert `grep`/byte search for the secret string in the saved file returns 0 hits.

---

## 5. Spike Verification Results

A standalone spike was implemented and executed:
- Created a 2-page valid PDF from scratch.
- Initialized `pdfium-render` with `pdfium.dll`.
- Rendered Page 1 at 1200px width to PNG (56,992 bytes).
- Loaded the PDF into `lopdf`, swapped Page 1 and Page 2 in the page tree (`Kids.swap(0, 1)`).
- Appended a real PDF annotation dictionary (`/Type /Annot /Subtype /Square /Rect [100, 650, 300, 750]`) with appearance attributes.
- Saved to disk as `edited_test.pdf`.
- Reopened with `pdfium` and asserted:
  - Page count: 2.
  - Page 1 text matched original Page 2 ("Page 2: Original Second Page").
  - Annotation count on Page 1: 1, with bounds exactly `left=100, bottom=650, right=300, top=750`.
  - Re-rendered Page 1 with the annotation visible.
- **Result**: Spike passed 100% with zero errors.
