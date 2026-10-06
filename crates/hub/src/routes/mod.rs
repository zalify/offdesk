mod agent_browser;
mod agent_sessions;
mod api_tokens;
mod auth;
mod bookmarks;
mod bootstrap;
mod focus;
mod mode;
mod registration;
mod relays;
mod settings;
mod terminals;
mod todos;

use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(crate::secure::management_router())
        .merge(auth::router())
        .merge(terminals::router())
        .merge(todos::router())
        .merge(agent_browser::router())
        .merge(relays::router())
        .merge(agent_sessions::router())
        .merge(bootstrap::router())
        .merge(focus::router())
        .merge(registration::router())
        .merge(bookmarks::router())
        .merge(api_tokens::router())
        .merge(mode::router())
        .merge(settings::router())
}
