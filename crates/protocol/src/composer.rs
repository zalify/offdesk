use serde::{Deserialize, Serialize};

pub const COMPOSER_V1: &str = "composer-v1";
pub const MAX_COMPOSER_TEXT: usize = 64 * 1024;
pub const MAX_COMPOSER_ATTACHMENTS: usize = 4;
pub const MAX_COMPOSER_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposerAttachment {
    pub data: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposerMessage {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<ComposerAttachment>,
}

impl ComposerMessage {
    pub fn validate(&self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.id).is_err() {
            return Err("Invalid message ID".into());
        }
        if self.text.len() > MAX_COMPOSER_TEXT || self.attachments.len() > MAX_COMPOSER_ATTACHMENTS
        {
            return Err("Message is too large".into());
        }
        if self.text.trim().is_empty() && self.attachments.is_empty() {
            return Err("Write a message or attach a file".into());
        }
        // Text is a paste, never a source of terminal escape/control commands.
        if self
            .text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Err("Message contains terminal control characters".into());
        }
        let mut encoded_size = 0usize;
        for attachment in &self.attachments {
            if attachment.mime.len() > 255 || attachment.filename.as_ref().is_some_and(|name| name.len() > 1024) {
                return Err("Attachment metadata is too long".into());
            }
            encoded_size = encoded_size.saturating_add(attachment.data.len());
        }
        if encoded_size > MAX_COMPOSER_ATTACHMENT_BYTES * 4 / 3 + 16 {
            return Err("Files must total at most 20 MB".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ComposerStatus {
    Delivered,
    Failed,
    /// May have reached the PTY. Never automatically replay this message.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposerReceipt {
    pub id: String,
    pub status: ComposerStatus,
    pub detail: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(text: &str) -> ComposerMessage {
        ComposerMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.into(),
            attachments: vec![],
        }
    }
    #[test]
    fn composer_accepts_multiline_unicode_but_rejects_terminal_escape_injection() {
        assert!(message("第一行\r\n第二行\t/command").validate().is_ok());
        assert!(message("hello\x1b[201~\rmalicious").validate().is_err());
        assert!(message("\x03").validate().is_err());
        assert!(message("  \n").validate().is_err());
        assert!(message(&"中".repeat(MAX_COMPOSER_TEXT / 3 + 1))
            .validate()
            .is_err());
    }

    #[test]
    fn named_documents_and_legacy_image_messages_are_supported() {
        let mut document = message("");
        document.attachments.push(ComposerAttachment {
            data: "ZG9jdW1lbnQ=".into(),
            mime: "application/octet-stream".into(),
            filename: Some("客户 report.pdf".into()),
        });
        assert!(document.validate().is_ok());
        let legacy: ComposerAttachment = serde_json::from_str(
            r#"{"data":"aW1hZ2U=","mime":"image/png"}"#,
        ).unwrap();
        assert!(legacy.filename.is_none());
        document.attachments[0].filename = Some("x".repeat(1025));
        assert!(document.validate().is_err());
    }
}
