mod agent_browser;
pub(crate) mod agent_runs;
mod agent_sessions;
mod api_tokens;
mod auth;
mod bookmarks;
mod bootstrap;
mod focus;
mod integrations;
mod mode;
mod registration;
mod settings;
mod terminals;
mod version;

use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(crate::secure::management_router())
        .merge(auth::router())
        .merge(terminals::router())
        .merge(agent_browser::router())
        .merge(agent_sessions::router())
        .merge(agent_runs::router())
        .merge(integrations::router())
        .merge(bootstrap::router())
        .merge(focus::router())
        .merge(registration::router())
        .merge(bookmarks::router())
        .merge(api_tokens::router())
        .merge(mode::router())
        .merge(settings::router())
        .merge(version::router())
}
