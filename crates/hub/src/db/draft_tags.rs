//! Draft tags: normalisation of explicit tags and extraction of inline
//! `#tag` / `#tag/sub` mentions from markdown content.
//!
//! A tag is a path of 1-4 segments joined by `/`, stored without a leading
//! `#`. Case is preserved; comparison and de-duplication are case-insensitive
//! (the first spelling wins).

pub const MAX_SEGMENTS: usize = 4;
pub const MAX_SEGMENT_CHARS: usize = 32;
pub const MAX_EXPLICIT_TAGS: usize = 20;
pub const MAX_INLINE_TAGS: usize = 20;

/// Characters (besides start-of-line and whitespace) that may precede the `#`
/// of an inline tag.
const TAG_PREFIX_CHARS: &str = "(（[【,，;；:：。";

fn key(tag: &str) -> String {
    tag.to_lowercase()
}

/// Normalise one explicit tag. Errors carry a user-facing message.
fn normalize_one(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let body = trimmed.strip_prefix('#').unwrap_or(trimmed);
    let segments: Vec<&str> = body.split('/').map(str::trim).collect();
    if segments.len() > MAX_SEGMENTS {
        return Err(format!(
            "tag '{raw}' has more than {MAX_SEGMENTS} levels"
        ));
    }
    for seg in &segments {
        if seg.is_empty() {
            return Err(format!("tag '{raw}' has an empty segment"));
        }
        if seg.chars().count() > MAX_SEGMENT_CHARS {
            return Err(format!(
                "tag '{raw}' has a segment longer than {MAX_SEGMENT_CHARS} characters"
            ));
        }
        if seg
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '#' | ',' | '"' | '\''))
        {
            return Err(format!(
                "tag '{raw}' contains whitespace or one of # , \" ' or control characters"
            ));
        }
    }
    Ok(segments.join("/"))
}

/// Normalise and de-duplicate a list of explicit tags (case-insensitive,
/// first spelling wins). Rejects invalid tags and more than 20 tags.
pub fn normalize_tags(input: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in input {
        let tag = normalize_one(raw)?;
        if seen.insert(key(&tag)) {
            out.push(tag);
        }
    }
    if out.len() > MAX_EXPLICIT_TAGS {
        return Err(format!(
            "a draft can have at most {MAX_EXPLICIT_TAGS} explicit tags"
        ));
    }
    Ok(out)
}

/// Parse the stored `drafts.tags` JSON column; malformed values read as empty.
pub fn parse_stored(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

/// Serialise explicit tags for the `drafts.tags` column.
pub fn to_stored(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

/// Union of explicit tags (stored order) followed by inline tags not already
/// present, plus the subset that exists only inline.
pub fn merge(explicit: &[String], content: &str) -> (Vec<String>, Vec<String>) {
    let mut tags: Vec<String> = explicit.to_vec();
    let mut seen: std::collections::HashSet<String> = tags.iter().map(|t| key(t)).collect();
    let mut inline_only = Vec::new();
    for tag in extract_inline_tags(content) {
        if seen.insert(key(&tag)) {
            tags.push(tag.clone());
            inline_only.push(tag);
        }
    }
    (tags, inline_only)
}

/// Mask regions of a line where `#` must not start a tag: inline code spans,
/// markdown link destinations `](...)` and bare URLs (`scheme://...`).
fn mask_line(chars: &[char]) -> Vec<bool> {
    let n = chars.len();
    let mut masked = vec![false; n];

    // Inline code spans: a run of N backticks closes at the next run of
    // exactly N backticks on the same line. An unmatched run is literal.
    let mut i = 0;
    while i < n {
        if chars[i] == '`' {
            let start = i;
            while i < n && chars[i] == '`' {
                i += 1;
            }
            let run = i - start;
            let mut j = i;
            let mut close = None;
            while j < n {
                if chars[j] == '`' {
                    let s = j;
                    while j < n && chars[j] == '`' {
                        j += 1;
                    }
                    if j - s == run {
                        close = Some(j);
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            if let Some(end) = close {
                for m in masked.iter_mut().take(end).skip(start) {
                    *m = true;
                }
                i = end;
            }
        } else {
            i += 1;
        }
    }

    // Link / image destinations: `](` up to the next `)`.
    let mut i = 0;
    while i + 1 < n {
        if chars[i] == ']' && chars[i + 1] == '(' && !masked[i] {
            let mut j = i + 2;
            while j < n && chars[j] != ')' {
                j += 1;
            }
            let end = if j < n { j + 1 } else { n };
            for m in masked.iter_mut().take(end).skip(i) {
                *m = true;
            }
            i = end;
        } else {
            i += 1;
        }
    }

    // Bare URLs: `scheme://` extends back over the scheme and forward to the
    // next whitespace.
    let mut i = 0;
    while i + 2 < n {
        if chars[i] == ':' && chars[i + 1] == '/' && chars[i + 2] == '/' {
            let mut s = i;
            while s > 0 && (chars[s - 1].is_ascii_alphanumeric() || matches!(chars[s - 1], '+' | '.' | '-')) {
                s -= 1;
            }
            let mut e = i + 3;
            while e < n && !chars[e].is_whitespace() {
                e += 1;
            }
            for m in masked.iter_mut().take(e).skip(s) {
                *m = true;
            }
            i = e;
        } else {
            i += 1;
        }
    }
    masked
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// Validate a raw candidate (characters after `#`). Returns the tag, or None
/// when it must be discarded.
fn accept_candidate(raw: &str) -> Option<String> {
    // A single trailing slash is stripped rather than discarded.
    let cand = raw.strip_suffix('/').unwrap_or(raw);
    if cand.is_empty() {
        return None;
    }
    if cand.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if matches!(cand.chars().count(), 3 | 4 | 6 | 8) && cand.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let segments: Vec<&str> = cand.split('/').collect();
    if segments.len() > MAX_SEGMENTS {
        return None;
    }
    if segments
        .iter()
        .any(|s| s.is_empty() || s.chars().count() > MAX_SEGMENT_CHARS)
    {
        return None;
    }
    Some(cand.to_string())
}

/// Opening/closing fence detection for ``` and ~~~ fences. Returns the fence
/// character and run length when the line starts with one.
fn fence_of(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let len = t.chars().take_while(|&x| x == c).count();
    if len >= 3 {
        Some((c, len))
    } else {
        None
    }
}

/// Extract inline tags from markdown content (de-duplicated, at most 20).
pub fn extract_inline_tags(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut fence: Option<(char, usize)> = None;

    'lines: for line in content.lines() {
        if let Some((fc, flen)) = fence {
            // Inside a fence: only a matching closing fence ends it.
            if let Some((c, len)) = fence_of(line) {
                let rest = line.trim_start().trim_start_matches(c);
                if c == fc && len >= flen && rest.trim().is_empty() {
                    fence = None;
                }
            }
            continue;
        }
        if let Some(f) = fence_of(line) {
            // A backtick fence's info string may not contain backticks;
            // otherwise it is an inline span like ```x```.
            let info_has_tick = f.0 == '`'
                && line.trim_start().trim_start_matches('`').contains('`');
            if !info_has_tick {
                fence = Some(f);
                continue;
            }
        }

        let chars: Vec<char> = line.chars().collect();
        let masked = mask_line(&chars);
        let mut i = 0;
        while i < chars.len() {
            if chars[i] != '#' || masked[i] {
                i += 1;
                continue;
            }
            let allowed_prefix = i == 0
                || chars[i - 1].is_whitespace()
                || TAG_PREFIX_CHARS.contains(chars[i - 1]);
            let mut j = i + 1;
            while j < chars.len() && !masked[j] && is_tag_char(chars[j]) {
                j += 1;
            }
            if allowed_prefix && j > i + 1 {
                let raw: String = chars[i + 1..j].iter().collect();
                if let Some(tag) = accept_candidate(&raw) {
                    if seen.insert(key(&tag)) {
                        out.push(tag);
                        if out.len() >= MAX_INLINE_TAGS {
                            break 'lines;
                        }
                    }
                }
            }
            i = j.max(i + 1);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(s: &str) -> Vec<String> {
        extract_inline_tags(s)
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn headings_are_not_tags() {
        assert!(ex("# Title\n## Sub title\n### x").is_empty());
        assert!(ex("#Title").contains(&"Title".to_string()));
    }

    #[test]
    fn digits_and_hex_colours_are_discarded() {
        assert!(ex("see #123").is_empty());
        assert!(ex("color #fff and #1a2b3c and #abcd and #11223344").is_empty());
        assert!(ex("#abc").is_empty());
        assert_eq!(ex("#abcx"), v(&["abcx"]));
        // 5 hex letters is not a colour length.
        assert_eq!(ex("#abcde"), v(&["abcde"]));
        assert_eq!(ex("#2024-01"), v(&["2024-01"]));
    }

    #[test]
    fn fenced_code_is_ignored() {
        let src = "```c\n#include <x>\n# comment\n#todo\n```\n#after";
        assert_eq!(ex(src), v(&["after"]));
    }

    #[test]
    fn tilde_fences_are_ignored() {
        let src = "~~~\n#inside\n~~~\n#outside";
        assert_eq!(ex(src), v(&["outside"]));
        // A backtick line does not close a tilde fence.
        let src = "~~~\n```\n#inside\n~~~\n#out";
        assert_eq!(ex(src), v(&["out"]));
    }

    #[test]
    fn unclosed_fence_swallows_rest() {
        assert_eq!(ex("#before\n```\n#a\n#b"), v(&["before"]));
    }

    #[test]
    fn longer_fence_needs_matching_close() {
        let src = "````\n```\n#inside\n```\n````\n#out";
        assert_eq!(ex(src), v(&["out"]));
    }

    #[test]
    fn inline_code_is_ignored() {
        assert_eq!(ex("use `#foo` then #bar"), v(&["bar"]));
        assert_eq!(ex("``a #x `` #y"), v(&["y"]));
        // Unmatched backtick is literal.
        assert_eq!(ex("a ` #x"), v(&["x"]));
    }

    #[test]
    fn links_and_urls_are_ignored() {
        assert!(ex("[x](http://a/b#frag)").is_empty());
        assert!(ex("http://a/#frag").is_empty());
        assert!(ex("[x](#anchor)").is_empty());
        assert!(ex("![img](a.png#x)").is_empty());
        assert!(ex("go to https://a.com/p #nope-no").contains(&"nope-no".to_string()));
        assert!(ex("(see https://a.com/#frag)").is_empty());
        // A real tag after a link still counts.
        assert_eq!(ex("[x](http://a) #real"), v(&["real"]));
    }

    #[test]
    fn cjk_tags() {
        assert_eq!(ex("#调研/竞品"), v(&["调研/竞品"]));
        assert_eq!(ex("记录 #调研/竞品。"), v(&["调研/竞品"]));
        assert_eq!(ex("（#想法）"), v(&["想法"]));
    }

    #[test]
    fn punctuation_ends_tag() {
        assert_eq!(ex("#todo, then"), v(&["todo"]));
        assert_eq!(ex("#todo。后面"), v(&["todo"]));
        assert_eq!(ex("done:#a;#b"), v(&["a", "b"]));
        assert_eq!(ex("x #a! #b?"), v(&["a", "b"]));
    }

    #[test]
    fn slash_rules() {
        assert!(ex("#a//b").is_empty());
        assert_eq!(ex("#a/b/"), v(&["a/b"]));
        assert_eq!(ex("#a/"), v(&["a"]));
        assert!(ex("#/a").is_empty());
        assert!(ex("#/").is_empty());
        assert_eq!(ex("#a/b/c/d"), v(&["a/b/c/d"]));
        assert!(ex("#a/b/c/d/e").is_empty());
        let long = format!("#a/{}", "x".repeat(33));
        assert!(ex(&long).is_empty());
        let ok = format!("#{}", "x".repeat(32));
        assert_eq!(ex(&ok).len(), 1);
    }

    #[test]
    fn duplicates_differing_in_case() {
        assert_eq!(ex("#Todo #todo #TODO"), v(&["Todo"]));
    }

    #[test]
    fn tag_position_rules() {
        assert_eq!(ex("#start"), v(&["start"]));
        assert!(ex("foo#bar").is_empty());
        assert_eq!(ex("a\n#second line"), v(&["second"]));
        assert_eq!(ex("tab\t#t"), v(&["t"]));
        assert!(ex("##double").is_empty());
        assert!(ex("a #").is_empty());
    }

    #[test]
    fn inline_tag_cap() {
        let src: String = (0..30).map(|i| format!("#t{i} ")).collect();
        let tags = ex(&src);
        assert_eq!(tags.len(), MAX_INLINE_TAGS);
        assert_eq!(tags[0], "t0");
    }

    #[test]
    fn normalize_basic() {
        assert_eq!(normalize_tags(&v(&[" #a/b ", "c"])).unwrap(), v(&["a/b", "c"]));
        assert_eq!(normalize_tags(&v(&["A", "a", "B"])).unwrap(), v(&["A", "B"]));
        assert_eq!(normalize_tags(&v(&["a / b"])).unwrap(), v(&["a/b"]));
        assert_eq!(normalize_tags(&[]).unwrap(), Vec::<String>::new());
        assert_eq!(normalize_tags(&v(&["调研/竞品"])).unwrap(), v(&["调研/竞品"]));
    }

    #[test]
    fn normalize_rejects_bad_input() {
        for bad in ["", "#", "a//b", "a/", "/a", "a b", "a,b", "a#b", "##a", "a\"b", "a'b", "a\tb", "a\u{7}b",
            "a/b/c/d/e"] {
            assert!(normalize_tags(&v(&[bad])).is_err(), "should reject {bad:?}");
        }
        assert!(normalize_tags(&v(&[&"x".repeat(33)])).is_err());
        assert!(normalize_tags(&v(&[&"x".repeat(32)])).is_ok());
        let many: Vec<String> = (0..21).map(|i| format!("t{i}")).collect();
        assert!(normalize_tags(&many).is_err());
        let ok: Vec<String> = (0..20).map(|i| format!("t{i}")).collect();
        assert_eq!(normalize_tags(&ok).unwrap().len(), 20);
        // Duplicates collapse before the count check.
        let dup: Vec<String> = (0..25).map(|_| "same".to_string()).collect();
        assert_eq!(normalize_tags(&dup).unwrap().len(), 1);
    }

    #[test]
    fn merge_unions_explicit_first() {
        let (tags, inline) = merge(&v(&["Work", "x"]), "#work #todo #Y");
        assert_eq!(tags, v(&["Work", "x", "todo", "Y"]));
        assert_eq!(inline, v(&["todo", "Y"]));
    }

    #[test]
    fn stored_roundtrip() {
        let tags = v(&["a/b", "c"]);
        assert_eq!(parse_stored(&to_stored(&tags)), tags);
        assert!(parse_stored("garbage").is_empty());
    }
}
