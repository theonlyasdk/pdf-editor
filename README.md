# PDF Editor Desktop

A fast, calm, professional desktop PDF editor built with **Tauri v2**, **Rust**, and **Bootstrap 6 (alpha)**. Designed from the ground up for privacy, performance, and true PDF specification compliance.

---

## Key Features

- **Blazing Performance**:
  - Pure Rust core engine (`pdf-core`) with zero UI thread blocking.
  - 500-page document load time: **6.47 ms**.
  - First-page render time: **100.67 ms**.
  - Background multi-threaded page rendering with an LRU cache keyed by `(page_index, scale, revision_id)`.
- **True Redaction**:
  - Distinguishes explicitly between **Cover Erase** (cosmetic overlay) and **True Redact** (permanent excision of text glyphs and graphics operators from the PDF content stream).
  - Verifies that redacted text is completely absent from text extraction and raw physical file bytes.
- **Programmatic Page Selection**:
  - Expressive DSL evaluator supporting ranges, steps, keywords, and negations:
    `1-5, 8, 11-end, odd, even, last, last-2, !3, 1-20/3`
- **Non-Destructive Cropping**:
  - Adjustable crop box with draggable handles, margin trim presets (10%, A4, US Letter), and unit switching (pt, mm, in). Writes standard PDF `/CropBox` without altering original `/MediaBox`.
- **Vector Annotations**:
  - Real PDF annotations with standard appearance streams (`/AP`): Highlight, Underline, StrikeOut, Squiggly, FreeText, Sticky Notes, Square, Circle, Line, Arrow, Freehand Ink (with smooth curve interpolation), and Stamps.
  - Option to permanently flatten annotations into the page stream.
- **Safe Atomic Persistence**:
  - Writes to a temporary file, verifies the document reopens cleanly with matching page counts, optionally creates a `.bak` backup, and atomically replaces the original file.
- **Calm, Zero-AI-Slop Interface**:
  - Bootstrap 6 alpha tokens layered with neutral slate palettes and a single royal blue accent (`#2563eb`).
  - Searchable Command Palette (`Ctrl+K`), in-window keyboard shortcuts, toast notifications with Undo, and light/dark theme modes.

---

## Architecture

The project is structured cleanly as a Cargo workspace:

```
├── crates/
│   └── pdf-core/         # Pure Rust headless core crate (0 Tauri dependency)
│       ├── src/
│       │   ├── annotations.rs   # PDF annotation serializer & appearance streams
│       │   ├── commands.rs      # Invertible command engine (undo/redo stack)
│       │   ├── document.rs      # lopdf DocumentState & page tree manager
│       │   ├── persistence.rs   # Safe atomic save & backup protocol
│       │   ├── range_parser.rs  # Programmatic selection DSL parser
│       │   ├── redaction.rs     # Content stream operator exciser & byte scrubber
│       │   ├── renderer.rs      # pdfium-render thread-safe rasterizer & text search
│       │   └── types.rs         # Common DTOs and page geometries
│       └── tests/               # Exhaustive test suites & fixtures (500+ pages)
├── src-tauri/            # Thin Tauri v2 IPC layer & window lifecycle
├── src/                  # Modern TypeScript frontend (Bootstrap 6 alpha, Vite)
└── docs/
    └── RESEARCH.md       # Bootstrap 6, Tauri v2, & PDF stack evaluation
```

---

## Prerequisites

- **Rust**: 1.80+ (tested on Rust 1.99.1)
- **Node.js**: v20+ (tested on Node v26.13.0, npm 11.20.0)
- **Platform**: Windows, macOS, or Linux

---

## Installation & Running

### 1. Install Frontend Dependencies
```bash
npm install
```

### 2. Run in Development Mode
```bash
npm run tauri dev
```

### 3. Run Test Suites
```bash
# Run all pure Rust core unit & integration tests
cargo test --workspace

# Run Rust linter
cargo clippy --workspace

# Run frontend Vitest suite
npm test
```

### 4. Build Production Desktop App & Bundles
```bash
# Build frontend bundle
npm run build

# Build standalone desktop executable
cargo build --release --package pdf-editor

# Generate native installers (NSIS setup .exe and MSI package)
cargo tauri build
```
Production outputs:
- **Executable**: `target/release/pdf-editor.exe` (14.2 MB)
- **NSIS Installer**: `target/release/bundle/nsis/PDF Editor_0.1.0_x64-setup.exe` (2.97 MB)
- **MSI Installer**: `target/release/bundle/msi/PDF Editor_0.1.0_x64_en-US.msi` (4.51 MB)

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+O` | Open PDF Document |
| `Ctrl+S` | Save Document |
| `Ctrl+Shift+S` | Save Document As... |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+K` | Open Command Palette |
| `Ctrl++` / `Ctrl+-` | Zoom In / Zoom Out |
| `Ctrl+0` | Reset Zoom to 100% |
| `Ctrl+T` | Toggle Light / Dark Theme |
| `V` | Select & Move Tool |
| `H` | Pan / Hand Tool |
| `T` | Free Text Tool |
| `P` | Freehand Pen Tool |
| `C` | Crop Tool |
