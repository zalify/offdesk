//! v2 application codec: JSON control/text, raw binary socket data. Metadata is
//! inside Noise. Tauri may still serialize binary as base64 at its IPC boundary.
use crate::{
    messages::{Request, Response},
    Error,
};

pub trait WireMessage: Send {
    fn key(&self) -> String;
    fn control(&self) -> bool;
    fn encode(self) -> Result<Vec<u8>, Error>;
}
fn json(value: &impl serde::Serialize) -> Result<Vec<u8>, Error> {
    let mut bytes = vec![0];
    serde_json::to_writer(&mut bytes, value).map_err(|_| Error::InvalidMessage)?;
    Ok(bytes)
}
fn binary(id: String, mut data: Vec<u8>) -> Result<Vec<u8>, Error> {
    if id.is_empty() || id.len() > 64 {
        return Err(Error::InvalidMessage);
    }
    let mut header = vec![1, id.len() as u8];
    header.extend_from_slice(id.as_bytes());
    data.splice(..0, header);
    Ok(data)
}
fn read_binary(bytes: &[u8]) -> Result<(String, Vec<u8>), Error> {
    let n = *bytes.get(1).ok_or(Error::InvalidMessage)? as usize;
    if n == 0 || n > 64 || bytes.len() < n + 2 {
        return Err(Error::InvalidMessage);
    }
    let id = std::str::from_utf8(&bytes[2..n + 2])
        .map_err(|_| Error::InvalidMessage)?
        .to_owned();
    Ok((id, bytes[n + 2..].to_vec()))
}
impl WireMessage for Request {
    fn key(&self) -> String {
        match self {
            Self::Http { id, .. } => format!("http:{id}"),
            Self::Ping { .. } => "heartbeat".into(),
            Self::Open { id, .. }
            | Self::Text { id, .. }
            | Self::Binary { id, .. }
            | Self::Close { id } => format!("ws:{id}"),
        }
    }
    fn control(&self) -> bool {
        matches!(self, Self::Ping { .. })
    }
    fn encode(self) -> Result<Vec<u8>, Error> {
        match self {
            Self::Binary { id, data } => binary(id, data),
            other => json(&other),
        }
    }
}
impl WireMessage for Response {
    fn key(&self) -> String {
        self.id().to_owned()
    }
    fn control(&self) -> bool {
        matches!(self, Self::Pong { .. })
    }
    fn encode(self) -> Result<Vec<u8>, Error> {
        match self {
            Self::Binary { id, data } => binary(id, data),
            other => json(&other),
        }
    }
}
pub fn request(bytes: &[u8]) -> Result<Request, Error> {
    match bytes.first() {
        Some(0) => serde_json::from_slice(&bytes[1..]).map_err(|_| Error::InvalidMessage),
        Some(1) => {
            let (id, data) = read_binary(bytes)?;
            Ok(Request::Binary { id, data })
        }
        _ => Err(Error::InvalidMessage),
    }
}
pub fn response(bytes: &[u8]) -> Result<Response, Error> {
    match bytes.first() {
        Some(0) => serde_json::from_slice(&bytes[1..]).map_err(|_| Error::InvalidMessage),
        Some(1) => {
            let (id, data) = read_binary(bytes)?;
            Ok(Response::Binary { id, data })
        }
        _ => Err(Error::InvalidMessage),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_payloads_do_not_grow_by_base64_on_the_network() {
        let data = vec![255; 1024 * 1024];
        let bytes = Request::Binary {
            id: "terminal".into(),
            data: data.clone(),
        }
        .encode()
        .unwrap();
        assert_eq!(bytes.len(), data.len() + 2 + "terminal".len());
        match request(&bytes).unwrap() {
            Request::Binary { id, data: decoded } => {
                assert_eq!(id, "terminal");
                assert_eq!(decoded, data);
            }
            _ => panic!("binary"),
        }
        let bytes = Response::Binary {
            id: "terminal".into(),
            data: data.clone(),
        }
        .encode()
        .unwrap();
        match response(&bytes).unwrap() {
            Response::Binary { data: decoded, .. } => assert_eq!(decoded, data),
            _ => panic!("binary"),
        }
    }
    #[test]
    fn native_ipc_remains_compatible_and_invalid_network_headers_are_rejected() {
        let value = Response::Binary {
            id: "a".into(),
            data: vec![0, 255],
        };
        let json = serde_json::to_value(value).unwrap();
        assert_eq!(json["data"], "AP8=");
        for bytes in [&[][..], &[9], &[1], &[1, 65], &[1, 1, 255]] {
            assert!(response(bytes).is_err());
        }
        let request = Request::Text {
            id: "a".into(),
            data: "Enter".into(),
        };
        let bytes = request.encode().unwrap();
        assert!(
            matches!(super::request(&bytes).unwrap(), Request::Text { data, .. } if data == "Enter")
        );
    }
}
