use std::collections::BTreeSet;

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum RangeParseError {
    #[error("Empty expression")]
    EmptyExpression,
    #[error("Page number {0} out of range (total pages: {1})")]
    OutOfRange(usize, usize),
    #[error("Invalid token or syntax: '{0}'")]
    InvalidToken(String),
    #[error("Invalid step '{0}' in range")]
    InvalidStep(String),
    #[error("Start page {0} is greater than end page {1}")]
    ReversedRange(usize, usize),
    #[error("Total page count must be greater than 0")]
    ZeroTotalPages,
}

/// Parses a page selection expression (1-based for the user, returning 0-based page indices).
/// Supports:
/// - Single numbers: `1`, `8`
/// - Ranges: `1-5`
/// - Step ranges: `1-20/3` (pages 1, 4, 7, 10, 13, 16, 19)
/// - Keywords: `all`, `odd`, `even`, `last`, `end`
/// - Relative last: `last-1`, `last-2`, `end-3`
/// - Keyword ranges: `11-end`, `5-last`
/// - Negations: `!3`, `!odd`, `!1-5`
/// - Comma-separated combinations: `1-5, 8, 11-end, odd, even, last, last-2, !3, 1-20/3`
pub fn parse_page_range(
    expression: &str,
    total_pages: usize,
) -> Result<Vec<usize>, RangeParseError> {
    if total_pages == 0 {
        return Err(RangeParseError::ZeroTotalPages);
    }
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return Err(RangeParseError::EmptyExpression);
    }

    let mut selected_pages: BTreeSet<usize> = BTreeSet::new();
    let mut excluded_pages: BTreeSet<usize> = BTreeSet::new();

    // Split on comma or semicolon
    for part in trimmed.split([',', ';']) {
        let raw_token = part.trim();
        if raw_token.is_empty() {
            continue;
        }

        let is_negation = raw_token.starts_with('!') || raw_token.starts_with('~');
        let token = if is_negation {
            raw_token[1..].trim()
        } else {
            raw_token
        };

        if token.is_empty() {
            return Err(RangeParseError::InvalidToken(raw_token.to_string()));
        }

        let matched = parse_single_token(token, total_pages)?;
        if is_negation {
            excluded_pages.extend(matched);
        } else {
            selected_pages.extend(matched);
        }
    }

    // If only negations were provided (e.g. "!3"), default to all pages minus excluded
    if selected_pages.is_empty() && !excluded_pages.is_empty() {
        for p in 0..total_pages {
            selected_pages.insert(p);
        }
    }

    // Subtract excluded pages
    for ex in excluded_pages {
        selected_pages.remove(&ex);
    }

    Ok(selected_pages.into_iter().collect())
}

fn parse_single_token(token: &str, total_pages: usize) -> Result<Vec<usize>, RangeParseError> {
    let lower = token.to_lowercase();

    // Global keywords
    if lower == "all" || lower == "*" {
        return Ok((0..total_pages).collect());
    }
    if lower == "odd" {
        return Ok((0..total_pages).filter(|i| (i + 1) % 2 != 0).collect());
    }
    if lower == "even" {
        return Ok((0..total_pages).filter(|i| (i + 1) % 2 == 0).collect());
    }
    if lower == "last" || lower == "end" {
        return Ok(vec![total_pages - 1]);
    }

    // Relative last: e.g. "last-2", "end-1"
    if lower.starts_with("last-") || lower.starts_with("end-") {
        let prefix_len = if lower.starts_with("last-") { 5 } else { 4 };
        let offset_str = &lower[prefix_len..];
        if let Ok(offset) = offset_str.parse::<usize>() {
            if offset >= total_pages {
                return Err(RangeParseError::OutOfRange(0, total_pages));
            }
            let target_page = total_pages - 1 - offset;
            return Ok(vec![target_page]);
        }
    }

    // Step syntax: range/step e.g. "1-20/3"
    let (range_part, step) = if let Some((r, s)) = lower.split_once('/') {
        let step_val = s
            .trim()
            .parse::<usize>()
            .map_err(|_| RangeParseError::InvalidStep(s.to_string()))?;
        if step_val == 0 {
            return Err(RangeParseError::InvalidStep("0".to_string()));
        }
        (r.trim(), step_val)
    } else {
        (lower.as_str(), 1)
    };

    // Range: "start-end"
    if let Some((start_str, end_str)) = range_part.split_once('-') {
        let start = resolve_page_number(start_str.trim(), total_pages)?;
        let end = resolve_page_number(end_str.trim(), total_pages)?;
        if start > end {
            return Err(RangeParseError::ReversedRange(start + 1, end + 1));
        }

        let mut res = Vec::new();
        let mut curr = start;
        while curr <= end {
            res.push(curr);
            curr += step;
        }
        return Ok(res);
    }

    // Single number
    let page_0_based = resolve_page_number(range_part, total_pages)?;
    Ok(vec![page_0_based])
}

fn resolve_page_number(s: &str, total_pages: usize) -> Result<usize, RangeParseError> {
    let lower = s.to_lowercase();
    if lower == "last" || lower == "end" {
        return Ok(total_pages - 1);
    }
    if lower.starts_with("last-") || lower.starts_with("end-") {
        let prefix_len = if lower.starts_with("last-") { 5 } else { 4 };
        let offset_str = &lower[prefix_len..];
        if let Ok(offset) = offset_str.parse::<usize>() {
            if offset >= total_pages {
                return Err(RangeParseError::OutOfRange(0, total_pages));
            }
            return Ok(total_pages - 1 - offset);
        }
    }

    let num_1_based = s
        .parse::<usize>()
        .map_err(|_| RangeParseError::InvalidToken(s.to_string()))?;

    if num_1_based == 0 || num_1_based > total_pages {
        return Err(RangeParseError::OutOfRange(num_1_based, total_pages));
    }

    Ok(num_1_based - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_and_ranges() {
        let pages = parse_page_range("1, 3, 5-7", 10).unwrap();
        assert_eq!(pages, vec![0, 2, 4, 5, 6]);
    }

    #[test]
    fn test_keywords() {
        assert_eq!(parse_page_range("odd", 5).unwrap(), vec![0, 2, 4]);
        assert_eq!(parse_page_range("even", 5).unwrap(), vec![1, 3]);
        assert_eq!(parse_page_range("last", 5).unwrap(), vec![4]);
        assert_eq!(parse_page_range("last-2", 5).unwrap(), vec![2]);
        assert_eq!(parse_page_range("3-end", 5).unwrap(), vec![2, 3, 4]);
    }

    #[test]
    fn test_step_syntax() {
        // 1-20 with step 3 in 20-page doc: 1, 4, 7, 10, 13, 16, 19 -> 0, 3, 6, 9, 12, 15, 18
        let pages = parse_page_range("1-20/3", 20).unwrap();
        assert_eq!(pages, vec![0, 3, 6, 9, 12, 15, 18]);
    }

    #[test]
    fn test_negation() {
        // "!3" on 5 pages -> 1, 2, 4, 5 -> [0, 1, 3, 4]
        assert_eq!(parse_page_range("!3", 5).unwrap(), vec![0, 1, 3, 4]);
        // "1-5, !2" on 5 pages -> [0, 2, 3, 4]
        assert_eq!(parse_page_range("1-5, !2", 5).unwrap(), vec![0, 2, 3, 4]);
    }

    #[test]
    fn test_complex_expression() {
        // "1-5, 8, 11-end, odd, even, last, last-2, !3, 1-20/3"
        let pages = parse_page_range("1-5, 8, 11-end, !3", 15).unwrap();
        // 1-5 except 3: 1, 2, 4, 5 -> [0, 1, 3, 4]
        // 8 -> [7]
        // 11-15 -> [10, 11, 12, 13, 14]
        assert_eq!(pages, vec![0, 1, 3, 4, 7, 10, 11, 12, 13, 14]);
    }

    #[test]
    fn test_errors() {
        assert!(matches!(
            parse_page_range("", 5),
            Err(RangeParseError::EmptyExpression)
        ));
        assert!(matches!(
            parse_page_range("15", 5),
            Err(RangeParseError::OutOfRange(15, 5))
        ));
        assert!(matches!(
            parse_page_range("5-2", 10),
            Err(RangeParseError::ReversedRange(5, 2))
        ));
        assert!(matches!(
            parse_page_range("abc", 5),
            Err(RangeParseError::InvalidToken(_))
        ));
    }
}
