use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const CAPABILITY: &str = "preview-tcp-v1";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AddressFamily {
    #[default]
    Ipv4,
    Ipv6,
}

impl AddressFamily {
    pub fn loopback(self, port: u16) -> SocketAddr {
        SocketAddr::new(
            match self {
                Self::Ipv4 => IpAddr::V4(Ipv4Addr::LOCALHOST),
                Self::Ipv6 => IpAddr::V6(Ipv6Addr::LOCALHOST),
            },
            port,
        )
    }
}
