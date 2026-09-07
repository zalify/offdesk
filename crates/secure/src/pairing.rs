use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use url::Url;

/// Public trust anchor, safe to retain after the one-time code is consumed.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub hub_url: String,
    pub public_key: String,
}
impl Endpoint {
    pub fn key(&self) -> Result<[u8; 32], String> {
        URL_SAFE_NO_PAD
            .decode(&self.public_key)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| "Invalid Hub public key".into())
    }
    pub fn validate(&self) -> Result<(), String> {
        self.key()?;
        validate_origin(&self.hub_url)
    }
    pub fn websocket_url(&self) -> Result<String, String> {
        self.validate()?;
        let mut url = Url::parse(&self.hub_url).map_err(|_| "Invalid Hub address")?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).map_err(|_| "Invalid Hub address")?;
        url.set_path("/ws/secure");
        Ok(url.into())
    }
}

pub fn validate_origin(raw: &str) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|_| "Invalid Hub address")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("Use the Hub's HTTP or HTTPS origin without a path or credentials".into());
    }
    Ok(())
}

/// Deliberately not Debug: the one-time code grants access to its owner's Hub.
pub struct PairingDescriptor {
    pub endpoint: Endpoint,
    pub code: String,
}
impl PairingDescriptor {
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > 2048 {
            return Err("Invalid pairing code".into());
        }
        let url = Url::parse(raw).map_err(|_| "Invalid pairing code")?;
        if url.scheme() != "offdesk"
            || url.host_str() != Some("pair")
            || !matches!(url.path(), "" | "/")
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err("Scan an offdesk encrypted-pairing QR code".into());
        }
        let mut fields = std::collections::HashMap::new();
        for (key, value) in url.query_pairs() {
            if fields.insert(key.to_string(), value.to_string()).is_some() {
                return Err("Duplicate pairing fields".into());
            }
        }
        if fields.len() != 4 || fields.get("v").map(String::as_str) != Some("2") {
            return Err("Unsupported pairing code version".into());
        }
        let endpoint = Endpoint {
            hub_url: fields.remove("hub").ok_or("Missing Hub address")?,
            public_key: fields.remove("key").ok_or("Missing Hub public key")?,
        };
        endpoint.validate()?;
        let code = fields.remove("code").ok_or("Missing pairing code")?;
        if URL_SAFE_NO_PAD.decode(&code).map(|bytes| bytes.len()).ok() != Some(32) {
            return Err("Invalid pairing code".into());
        }
        Ok(Self { endpoint, code })
    }
    pub fn to_url(&self) -> Result<String, String> {
        self.endpoint.validate()?;
        let mut url = Url::parse("offdesk://pair").unwrap();
        url.query_pairs_mut()
            .append_pair("v", "2")
            .append_pair("hub", &self.endpoint.hub_url)
            .append_pair("key", &self.endpoint.public_key)
            .append_pair("code", &self.code);
        Self::parse(url.as_str())?;
        Ok(url.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qr_descriptor_pins_the_origin_and_public_key() {
        let descriptor = PairingDescriptor {
            endpoint: Endpoint {
                hub_url: "https://hub.example:8443".into(),
                public_key: URL_SAFE_NO_PAD.encode([4; 32]),
            },
            code: URL_SAFE_NO_PAD.encode([5; 32]),
        };
        let encoded = descriptor.to_url().unwrap();
        let decoded = PairingDescriptor::parse(&encoded).unwrap();
        assert_eq!(decoded.endpoint.key().unwrap(), [4; 32]);
        assert_eq!(
            decoded.endpoint.websocket_url().unwrap(),
            "wss://hub.example:8443/ws/secure"
        );
        assert_eq!(decoded.code, descriptor.code);
        assert!(PairingDescriptor::parse(&(encoded.clone() + "&code=anything")).is_err());
        assert!(PairingDescriptor::parse(&encoded.replace("v=2", "v=1")).is_err());
        assert!(
            PairingDescriptor::parse(&encoded.replace("hub.example", "user%40hub.example"))
                .is_err()
        );
        assert!(PairingDescriptor::parse(&(encoded + "#fragment")).is_err());
    }
}
