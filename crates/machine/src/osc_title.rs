const MAX_TITLE_BYTES: usize = 128;
const MAX_SEQUENCE_BYTES: usize = 4096;

enum State {
    Ground,
    Escape,
    Command,
    Semicolon(u8),
    Title {
        bytes: Vec<u8>,
        sequence_bytes: usize,
        escape: bool,
    },
    Ignore {
        sequence_bytes: usize,
        escape: bool,
    },
}

pub struct OscTitleScanner {
    state: State,
}

impl OscTitleScanner {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut titles = Vec::new();
        for &byte in chunk {
            self.state = match std::mem::replace(&mut self.state, State::Ground) {
                State::Ground => {
                    if byte == 0x1b {
                        State::Escape
                    } else {
                        State::Ground
                    }
                }
                State::Escape => match byte {
                    b']' => State::Command,
                    0x1b => State::Escape,
                    _ => State::Ground,
                },
                State::Command => match byte {
                    b'0' | b'2' => State::Semicolon(byte),
                    0x07 => State::Ground,
                    0x1b => State::Ignore {
                        sequence_bytes: 1,
                        escape: true,
                    },
                    _ => State::Ignore {
                        sequence_bytes: 1,
                        escape: false,
                    },
                },
                State::Semicolon(command) => {
                    if byte == b';' {
                        let _ = command;
                        State::Title {
                            bytes: Vec::with_capacity(MAX_TITLE_BYTES),
                            sequence_bytes: 0,
                            escape: false,
                        }
                    } else if byte == 0x07 {
                        State::Ground
                    } else {
                        State::Ignore {
                            sequence_bytes: 1,
                            escape: byte == 0x1b,
                        }
                    }
                }
                State::Title {
                    mut bytes,
                    mut sequence_bytes,
                    escape,
                } => {
                    sequence_bytes += 1;
                    if escape && byte == b'\\' {
                        push_title(&mut titles, &bytes);
                        State::Ground
                    } else if escape && byte == b']' {
                        State::Command
                    } else if byte == 0x07 {
                        push_title(&mut titles, &bytes);
                        State::Ground
                    } else if sequence_bytes >= MAX_SEQUENCE_BYTES {
                        if byte == 0x1b {
                            State::Escape
                        } else {
                            State::Ground
                        }
                    } else {
                        if !escape
                            && byte != 0x1b
                            && !byte.is_ascii_control()
                            && bytes.len() < MAX_TITLE_BYTES
                        {
                            bytes.push(byte);
                        }
                        State::Title {
                            bytes,
                            sequence_bytes,
                            escape: byte == 0x1b,
                        }
                    }
                }
                State::Ignore {
                    mut sequence_bytes,
                    escape,
                } => {
                    sequence_bytes += 1;
                    if byte == 0x07 || (escape && byte == b'\\') {
                        State::Ground
                    } else if escape && byte == b']' {
                        State::Command
                    } else if sequence_bytes >= MAX_SEQUENCE_BYTES {
                        if byte == 0x1b {
                            State::Escape
                        } else {
                            State::Ground
                        }
                    } else {
                        State::Ignore {
                            sequence_bytes,
                            escape: byte == 0x1b,
                        }
                    }
                }
            };
        }
        titles
    }
}

/// Emit a sanitized title, skipping empty ones: an empty OSC title (tmux
/// emits `ESC]0;BEL` for untitled panes) carries no information and would
/// only flip the hub-side title_source on every report.
fn push_title(titles: &mut Vec<String>, bytes: &[u8]) {
    let title = sanitize_title(bytes);
    if !title.is_empty() {
        titles.push(title);
    }
}

pub(crate) fn sanitize_title(bytes: &[u8]) -> String {
    let mut title = String::new();
    for character in String::from_utf8_lossy(bytes)
        .chars()
        .filter(|character| !character.is_control())
    {
        if title.len() + character.len_utf8() > MAX_TITLE_BYTES {
            break;
        }
        title.push(character);
    }
    title
}

impl Default for OscTitleScanner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::OscTitleScanner;

    #[test]
    fn scans_split_chunk_osc_two_with_bel_terminator() {
        let mut scanner = OscTitleScanner::new();
        assert!(scanner.push(b"before\x1b]2;my-").is_empty());
        assert_eq!(scanner.push(b"task\x07after"), ["my-task"]);
    }

    #[test]
    fn scans_osc_zero_with_st_terminator() {
        let mut scanner = OscTitleScanner::new();
        assert!(scanner.push(b"\x1b]0;editor\x1b").is_empty());
        assert_eq!(scanner.push(b"\\"), ["editor"]);
    }

    #[test]
    fn caps_titles_at_128_bytes_and_strips_control_characters() {
        let mut scanner = OscTitleScanner::new();
        let mut input = b"\x1b]2;abc\r\n\xc2\x85".to_vec();
        input.extend(std::iter::repeat_n(b'x', 200));
        input.push(0x07);

        let titles = scanner.push(&input);
        assert_eq!(titles.len(), 1);
        assert!(titles[0].len() <= 128);
        assert_eq!(&titles[0][..3], "abc");
        assert!(!titles[0].contains(['\r', '\n']));
        assert!(!titles[0].contains('\u{0085}'));

        let mut ascii_scanner = OscTitleScanner::new();
        let mut ascii_input = b"\x1b]2;".to_vec();
        ascii_input.extend(std::iter::repeat_n(b'x', 200));
        ascii_input.push(0x07);
        assert_eq!(ascii_scanner.push(&ascii_input)[0].len(), 128);
    }

    #[test]
    fn malformed_and_junk_sequences_do_not_corrupt_later_titles() {
        let mut scanner = OscTitleScanner::new();
        assert!(scanner
            .push(b"junk\x1b]9;ignored\x07\x1b]2missing-semicolon\x07")
            .is_empty());
        assert_eq!(scanner.push(b"\x1b]0;recovered\x1b\\"), ["recovered"]);
    }

    #[test]
    fn unterminated_malformed_sequence_resynchronizes_at_the_next_osc() {
        let mut scanner = OscTitleScanner::new();

        assert_eq!(
            scanner.push(b"\x1b]9;unterminated\x1b]2;recovered\x07"),
            ["recovered"]
        );
    }

    #[test]
    fn oversized_malformed_sequence_recovers_for_a_later_title() {
        let mut scanner = OscTitleScanner::new();
        let mut input = b"\x1b]9;".to_vec();
        input.extend(std::iter::repeat_n(b'x', 5000));
        input.extend_from_slice(b"\x1b]2;recovered\x07");

        assert_eq!(scanner.push(&input), ["recovered"]);
    }

    #[test]
    fn returns_every_complete_title_in_order() {
        let mut scanner = OscTitleScanner::new();
        assert_eq!(
            scanner.push(b"\x1b]0;first\x07text\x1b]2;second\x07"),
            ["first", "second"]
        );
    }

    #[test]
    fn empty_osc_titles_are_not_reported() {
        // tmux emits empty OSC sequences for untitled panes; they must not
        // reach the hub as empty title updates.
        let mut scanner = OscTitleScanner::new();
        assert!(scanner.push(b"\x1b]0;\x07").is_empty());
        assert!(scanner.push(b"\x1b]2;\x1b\\").is_empty());
        // Scanner still works normally afterwards.
        assert_eq!(scanner.push(b"\x1b]0;real\x07"), ["real"]);
        // A real title between empty ones comes through alone.
        let mut scanner = OscTitleScanner::new();
        assert_eq!(
            scanner.push(b"\x1b]0;\x07\x1b]2;kept\x07\x1b]0;\x07"),
            ["kept"]
        );
    }
}
