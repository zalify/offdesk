//! Whether a hub address is somewhere on this network.
//!
//! A hub on a LAN is the documented first setup, and a shell with
//! `HTTP_PROXY` set is a common developer environment. Left alone, reqwest
//! sends the hub's own traffic to that proxy, which answers a private address
//! with `502 Bad Gateway` and no body — while the WebSocket transport, which
//! ignores proxy variables entirely, connects fine. Half the client honouring
//! a proxy the other half cannot use is not a configuration anyone chose, so
//! local addresses skip it.

/// True for loopback, RFC1918 / link-local / unique-local addresses, and the
/// `.local` and `.internal` suffixes — the places a self-hosted hub lives.
pub fn is_local_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return false;
    }

    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                let octets = v4.octets();
                let is_cgnat_tailscale = octets[0] == 100 && (octets[1] & 0xc0) == 64;
                v4.is_loopback() || v4.is_private() || v4.is_link_local() || is_cgnat_tailscale
            }
            // `is_unique_local` and `is_unicast_link_local` are still
            // unstable, so the prefixes are matched directly: fc00::/7 and
            // fe80::/10.
            std::net::IpAddr::V6(v6) => {
                let first = v6.segments()[0];
                v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
            }
        };
    }

    let lower = host.to_ascii_lowercase();
    lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower.ends_with(".ts.net")
}

/// The host part of a URL, for [`is_local_host`]. Accepts the ws/wss forms the
/// hub URL is usually written in.
pub fn host_of(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split_once(']').map(|(h, _)| h)?
    } else {
        authority.split(':').next()?
    };
    (!host.is_empty()).then_some(host)
}

#[cfg(test)]
mod tests {
    use super::{host_of, is_local_host};

    #[test]
    fn a_lan_address_is_local() {
        for host in [
            "127.0.0.1",
            "192.168.1.223",
            "10.0.2.2",
            "172.16.4.4",
            "169.254.1.1",
            "100.64.0.1",
            "100.100.42.7",
        ] {
            assert!(is_local_host(host), "{host} should be local");
        }
    }

    #[test]
    fn a_lan_name_is_local() {
        for host in [
            "localhost",
            "nas.local",
            "MacBook-Pro.local",
            "hub.internal",
            "nas.tail1234.ts.net",
        ] {
            assert!(is_local_host(host), "{host} should be local");
        }
    }

    #[test]
    fn ipv6_loopback_and_unique_local_are_local() {
        for host in ["::1", "[::1]", "fd00::1", "fe80::1"] {
            assert!(is_local_host(host), "{host} should be local");
        }
    }

    #[test]
    fn a_public_hub_is_not_local() {
        for host in ["offdesk.example.com", "8.8.8.8", "2606:4700::1111", "example.local.com"] {
            assert!(!is_local_host(host), "{host} should not be local");
        }
    }

    #[test]
    fn the_host_comes_out_of_every_url_shape() {
        assert_eq!(host_of("ws://192.168.1.223:4317/ws/machine"), Some("192.168.1.223"));
        assert_eq!(host_of("https://offdesk.example.com"), Some("offdesk.example.com"));
        assert_eq!(host_of("http://user:pw@nas.local:4317/x"), Some("nas.local"));
        assert_eq!(host_of("http://[::1]:4317"), Some("::1"));
        assert_eq!(host_of("nas.local:4317"), Some("nas.local"));
        assert_eq!(host_of(""), None);
    }
}
