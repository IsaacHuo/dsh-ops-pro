//! #797: glob, grep and replace refuse pattern entries that can never match.

use serde_json::json;

/// The message each fault class must produce, named by its field.
fn expected(field: &str, index: usize, empty: bool) -> String {
    if empty {
        format!("{field}[{index}] must be a non-empty glob")
    } else {
        format!("{field}[{index}] must not contain an empty, \".\" or \"..\" path segment")
    }
}

/// #797: an empty entry used to compile to a literal that only the search
/// root satisfies, so a populated directory reported a complete scan with
/// zero files. An entry with an empty or "."/".." segment is just as
/// impossible against walked relative paths. Both are refused by name
/// before the path is opened, so a malformed request never costs a traversal.
#[test]
fn glob_refuses_entries_that_can_never_match() {
    let root = std::env::temp_dir();
    let root = root.to_str().unwrap();
    for (patterns, index, empty) in [
        (vec![""], 0, true),
        (vec!["", "!vendor/**"], 0, true),
        (vec!["**/*.md", "  "], 1, true),
        (vec!["\u{3000}"], 0, true),
        (vec!["./"], 0, true),
        (vec!["/"], 0, false),
        (vec!["src/"], 0, false),
        (vec!["a//b"], 0, false),
        (vec![".."], 0, false),
        (vec!["../**/*.md"], 0, false),
        (vec!["!src/"], 0, false),
    ] {
        let request = serde_json::from_value(json!({
            "root": root, "scope": "glob-invalid-pattern", "tool": "glob",
            "args": {"path": root, "pattern": patterns}
        }))
        .unwrap();
        let error = crate::dispatch(&request).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert_eq!(
            error.message,
            format!("glob: {}", expected("pattern", index, empty)),
            "{patterns:?}"
        );
    }
}

/// grep and replace filter with the same compiler, so the same impossible
/// entries must fail loudly instead of matching every file out (#797).
#[test]
fn grep_and_replace_refuse_filters_that_can_never_match() {
    let root = std::env::temp_dir();
    let root = root.to_str().unwrap();
    for (tool, args, empty) in [
        (
            "grep",
            json!({"path": root, "pattern": "needle", "glob": [""]}),
            true,
        ),
        (
            "grep",
            json!({"path": root, "pattern": "needle", "glob": ["src/"]}),
            false,
        ),
        (
            "replace",
            json!({"path": root, "pattern": "needle", "replacement": "x", "glob": ["  "]}),
            true,
        ),
        (
            "replace",
            json!({"path": root, "pattern": "needle", "replacement": "x", "glob": [".."]}),
            false,
        ),
    ] {
        let request = serde_json::from_value(json!({
            "root": root, "scope": "filter-invalid-glob", "tool": tool, "args": args
        }))
        .unwrap();
        let error = crate::dispatch(&request).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert_eq!(
            error.message,
            format!("{tool}: {}", expected("glob", 0, empty))
        );
    }
}
