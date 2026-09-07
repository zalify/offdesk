//! Non-secret entry points for a single QR-pinned Hub identity.
use crate::pairing::validate_origin;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    Local,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Route {
    pub kind: RouteKind,
    pub hub_url: String,
}

impl Route {
    pub fn from_url(raw: &str) -> Result<Self, String> {
        let url = url::Url::parse(raw).map_err(|_| "Invalid connection address")?;
        // Reuse the pairing rules: only origins, never credentials or paths.
        validate_origin(raw)?;
        let host = url.host_str().ok_or("Missing connection host")?;
        let local = host == "localhost"
            || host.ends_with(".local")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| match ip {
                    std::net::IpAddr::V4(ip) => {
                        ip.is_private() || ip.is_loopback() || ip.is_link_local()
                    }
                    std::net::IpAddr::V6(ip) => {
                        ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
                    }
                });
        Ok(Self {
            kind: if local {
                RouteKind::Local
            } else {
                RouteKind::Remote
            },
            hub_url: url.as_str().trim_end_matches('/').into(),
        })
    }
}

/// Bound discovery and discard duplicate/invalid origins. Never accepts a key
/// from discovery: all routes must still prove the original QR-pinned identity.
pub fn normalize(routes: Vec<Route>, current: &str) -> Vec<Route> {
    let mut result = Vec::new();
    for raw in std::iter::once(current.to_string()).chain(routes.into_iter().map(|r| r.hub_url)) {
        if let Ok(route) = Route::from_url(&raw) {
            if !result.iter().any(|r: &Route| r.hub_url == route.hub_url) {
                result.push(route);
            }
        }
        if result.len() == 8 {
            break;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_and_classifies_origins_without_trusting_advertised_labels() {
        assert_eq!(
            Route::from_url("http://192.168.1.2:4317/").unwrap().kind,
            RouteKind::Local
        );
        assert_eq!(
            Route::from_url("https://hub.example").unwrap().kind,
            RouteKind::Remote
        );
        assert!(Route::from_url("https://user:secret@hub.example").is_err());
        assert!(Route::from_url("https://hub.example/path").is_err());
        let routes = normalize(
            vec![Route {
                kind: RouteKind::Remote,
                hub_url: "http://192.168.1.2:4317/".into(),
            }],
            "http://192.168.1.2:4317",
        );
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].kind, RouteKind::Local);
    }
}
