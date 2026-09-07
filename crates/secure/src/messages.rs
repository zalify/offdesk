//! These values only travel inside authenticated Noise transport records.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Authenticate {
    Pair { code: String, device_name: String },
    Resume,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthenticationResult {
    Ready { device_id: String },
    Rejected { message: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Ping {
        id: String,
    },
    Http {
        id: String,
        method: String,
        path: String,
        body: Option<String>,
    },
    Open {
        id: String,
        path: String,
    },
    Text {
        id: String,
        data: String,
    },
    Binary {
        id: String,
        #[serde(with = "base64_data")]
        data: Vec<u8>,
    },
    Close {
        id: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Pong {
        id: String,
    },
    Http {
        id: String,
        status: u16,
        body: String,
    },
    Opened {
        id: String,
    },
    Text {
        id: String,
        data: String,
    },
    Binary {
        id: String,
        #[serde(with = "base64_data")]
        data: Vec<u8>,
    },
    Closed {
        id: String,
    },
    Error {
        id: String,
        message: String,
    },
}
impl Response {
    pub fn id(&self) -> &str {
        match self {
            Self::Pong { id }
            | Self::Http { id, .. }
            | Self::Opened { id }
            | Self::Text { id, .. }
            | Self::Binary { id, .. }
            | Self::Closed { id }
            | Self::Error { id, .. } => id,
        }
    }
}

// Base64 remains only at the native JSON IPC boundary; the encrypted network
// codec carries these bytes directly rather than serializing them into JSON.
mod base64_data {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(data: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(data))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        STANDARD
            .decode(String::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}
