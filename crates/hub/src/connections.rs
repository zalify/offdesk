//! Authenticated discovery. Pairing codes stay small and compatible; the App
//! learns other entry points only after proving its device identity.
use crate::{auth::AuthUser, AppState};
use axum::{extract::State, routing::get, Json, Router};
use offdesk_secure::routes::{Route, RouteKind};

pub fn router(listen: String, remote_url: Option<String>) -> Router<AppState> {
    Router::new().route(
        "/api/connection-routes",
        get(move |State(state): State<AppState>, _user: AuthUser| {
            let listen = listen.clone();
            let remote_url = remote_url.clone();
            async move {
                Json(advertise(
                    &listen,
                    remote_url.as_deref().unwrap_or(&state.base_url),
                    crate::first_run::local_network_addresses(),
                ))
            }
        }),
    )
}

fn advertise(listen: &str, public_url: &str, addresses: Vec<std::net::Ipv4Addr>) -> Vec<Route> {
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
    if let Ok(route) = Route::from_url(public_url) {
        if route.kind == RouteKind::Remote {
            routes.insert(0, route);
        }
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
        assert!(advertise("127.0.0.1:4317", "http://localhost:4317", ips.clone()).is_empty());
        let routes = advertise("192.168.1.2:5555", "https://remote.example", ips);
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].kind, RouteKind::Remote);
        assert_eq!(routes[1].hub_url, "http://192.168.1.2:5555");
    }
}
