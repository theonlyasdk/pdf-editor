# Defect & Bug Tracking (BUGS.md)

*This file tracks all defects discovered during development and testing iterations. Every bug has an associated root cause analysis, fix, and regression test. BUGS.md must end completely empty of open defects.*

## Resolved Defects

### 1. BUG-001: True Redaction Left Orphaned Content Streams in File Bytes
- **Severity**: Critical (Data leak / Security)
- **Discovery**: In `core_suite::test_true_redaction_and_byte_scrubbing`, byte inspection of the saved PDF found the confidential string was still present in the file.
- **Root Cause**: `lopdf` maintains an internal `BTreeMap<ObjectId, Object>`. When a new sanitized content stream was added and referenced by the Page dictionary, the old content stream object remained in the document object table and was serialized into the output bytes.
- **Fix**: Replaced the existing stream object in-place on the same `ObjectId` and called `doc.prune_objects()` to garbage-collect any unreferenced streams.
- **Verification**: `core_suite::test_true_redaction_and_byte_scrubbing` asserts `!raw_file_bytes.contains(secret_text)` and passes 100%.

### 2. BUG-002: ReorderPagesCommand Invertibility Failure on Undo
- **Severity**: High (State integrity)
- **Discovery**: In `core_suite::test_page_operations_and_invertibility`, calling `undo()` after reordering pages did not restore the original page order.
- **Root Cause**: `reorder_pages` was receiving the original permutation index array rather than the inverse mapping, which led to incorrect indexing against the already-mutated page list.
- **Fix**: Refactored `ReorderPagesCommand` to store explicit snapshot vectors of `ObjectId`: `previous_ids` and `new_ids`. `undo()` restores `previous_ids` directly into the Pages tree.
- **Verification**: `core_suite::test_page_operations_and_invertibility` verified across all operations.

### 3. BUG-003: TypeScript 7 ModuleResolution Deprecation
- **Severity**: Low (Build tooling)
- **Discovery**: Frontend build threw error: `Option 'moduleResolution=node10' has been removed. Please remove it from your configuration.`
- **Root Cause**: Modern TypeScript 7 deprecated `moduleResolution: "node"` in favor of `"bundler"`.
- **Fix**: Updated `tsconfig.json` to `"moduleResolution": "bundler"`.
- **Verification**: `npm run build` completed cleanly in 234ms.

### 4. BUG-004: Vite 8 Deprecated Esbuild Transpiler
- **Severity**: Medium (Build failure)
- **Discovery**: Vite 8 build failed with `Cannot find package 'esbuild'`.
- **Root Cause**: Vite 8 requires `esbuild` as an explicit dependency for production minification and chunk transpilation.
- **Fix**: Installed `esbuild@0.28.2` as a devDependency.
- **Verification**: Production build generated optimized bundle without errors.

---

## Open Defects
*(Zero open defects. All tests passing.)*
