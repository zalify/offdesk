//! Authenticated discovery. Pairing codes stay small and compatible; the App
//! learns other entry points only after proving its device identity.
use crate::{auth::AuthUser, AppState};
use axum::{extract::State, routing::get, Json, Router};
use offdesk_secure::routes::{Route, RouteKind};

pub fn router(listen: String, remote_url: Option<String>, database: String) -> Router<AppState> {
    Router::new().route(
        "/api/connection-routes",
        get(move |State(state): State<AppState>, _user: AuthUser| {
            let listen = listen.clone();
            let remote_url = remote_url.clone();
            // A managed address first; on the relay, its regional routes after it
            let managed = crate::cloud::advertised_routes(&database);
            async move {
                Json(advertise(
                    &listen,
                    managed.first().or(remote_url.as_ref()).unwrap_or(&state.base_url),
                    managed.get(1..).unwrap_or_default(),
                    crate::first_run::local_network_addresses(),
                ))
            }
        }),
    )
}

fn advertise(
    listen: &str,
    public_url: &str,
    extra: &[String],
    addresses: Vec<std::net::Ipv4Addr>,
) -> Vec<Route> {
    let mut routes = Vec::new();
    if let Ok(bound) = listen.parse::<std::net::SocketAddr>() {
        for ip in addresses {
            if bound.ip().is_unspecified() || bound.ip() == std::net::IpAddr::V4(ip) {
                if let Ok(route) = Route::from_url(&format!("http://{ip}:{}", bound.port())) {
                    routes.push(route);
                }
            }
        }
    }
    let remote = std::iter::once(public_url)
        .chain(extra.iter().map(String::as_str))
        .filter_map(|url| Route::from_url(url).ok())
        .filter(|route| route.kind == RouteKind::Remote);
    for (i, route) in remote.enumerate() {
        routes.insert(i, route);
    }
    routes.truncate(7);
    routes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advertises_only_bound_addresses_and_configured_remote_origin() {
        let ips = vec!["192.168.1.2".parse().unwrap(), "10.0.0.2".parse().unwrap()];
        assert!(advertise("127.0.0.1:4317", "http://localhost:4317", &[], ips.clone()).is_empty());
        let routes = advertise("192.168.1.2:5555", "https://remote.example", &[], ips.clone());
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].kind, RouteKind::Remote);
        assert_eq!(routes[1].hub_url, "http://192.168.1.2:5555");
        // The relay: the global address, then the regional routes, then the LAN
        let extra = ["https://ryanz.hk.relay.offdesk.cloud".to_string(), "https://ryanz.kr.relay.offdesk.cloud".to_string()];
        let routes = advertise("192.168.1.2:5555", "https://ryanz.relay.offdesk.cloud", &extra, ips);
        let urls: Vec<_> = routes.iter().map(|r| r.hub_url.as_str()).collect();
        assert_eq!(urls, ["https://ryanz.relay.offdesk.cloud", "https://ryanz.hk.relay.offdesk.cloud",
            "https://ryanz.kr.relay.offdesk.cloud", "http://192.168.1.2:5555"]);
    }
}
