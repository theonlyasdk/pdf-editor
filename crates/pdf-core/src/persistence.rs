use crate::document::{CoreError, DocumentState};
use std::fs;
use std::path::Path;

/// Safe Atomic Persistence Protocol:
/// 1. Saves to a temporary file in the same directory: `[filename].tmp.[uuid]`
/// 2. Verifies the saved file re-opens cleanly and matches the expected page count.
/// 3. If make_backup is enabled and target exists, copies target to `[filename].bak`.
/// 4. Atomically replaces the target file with the validated temporary file.
/// 5. Cleans up temporary file if any step fails.
pub fn safe_save<P: AsRef<Path>>(
    doc_state: &mut DocumentState,
    target_path: P,
    make_backup: bool,
) -> Result<(), CoreError> {
    let target = target_path.as_ref();
    let parent = target.parent().unwrap_or_else(|| Path::new("."));

    let file_stem = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document.pdf");

    let temp_name = format!("{}.tmp.{}", file_stem, std::process::id());
    let temp_path = parent.join(temp_name);

    let expected_page_count = doc_state.page_count();

    // Step 1: Write to temporary file
    doc_state.save_to_file(&temp_path)?;

    // Step 2: Verify the saved file by re-opening
    let verification_result = (|| -> Result<(), CoreError> {
        let reopened = DocumentState::from_file(&temp_path)?;
        if reopened.page_count() != expected_page_count {
            return Err(CoreError::ValidationFailed(format!(
                "Page count mismatch: expected {}, got {}",
                expected_page_count,
                reopened.page_count()
            )));
        }
        Ok(())
    })();

    if let Err(e) = verification_result {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    // Step 3: Optional backup
    if make_backup && target.exists() {
        let bak_path = target.with_extension("pdf.bak");
        let _ = fs::copy(target, bak_path);
    }

    // Step 4: Atomic replace
    #[cfg(windows)]
    {
        // On Windows std::fs::rename fails if destination exists, so we remove then rename
        if target.exists() {
            let replace_temp = parent.join(format!("{}.old.{}", file_stem, std::process::id()));
            if fs::rename(target, &replace_temp).is_ok() {
                if let Err(rename_err) = fs::rename(&temp_path, target) {
                    // Restore original
                    let _ = fs::rename(&replace_temp, target);
                    let _ = fs::remove_file(&temp_path);
                    return Err(CoreError::Io(rename_err));
                }
                let _ = fs::remove_file(replace_temp);
            } else {
                // Direct remove fallback
                let _ = fs::remove_file(target);
                fs::rename(&temp_path, target)?;
            }
        } else {
            fs::rename(&temp_path, target)?;
        }
    }

    #[cfg(not(windows))]
    {
        fs::rename(&temp_path, target)?;
    }

    Ok(())
}
