use axum::{
    extract::FromRequestParts,
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("Missing authentication")]
    MissingAuth,

    #[error("Invalid token")]
    InvalidToken,

    /// A scoped token asked for something outside its scopes.
    #[error("{0}")]
    Forbidden(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let status = match &self {
            AuthError::MissingAuth | AuthError::InvalidToken => StatusCode::UNAUTHORIZED,
            AuthError::Forbidden(_) => StatusCode::FORBIDDEN,
            AuthError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = serde_json::json!({ "error": self.to_string() });
        (status, axum::Json(body)).into_response()
    }
}

// ---------------------------------------------------------------------------
// JWT payload
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtPayload {
    pub sub: String,
    pub exp: i64,
}

/// Legacy JWT payload compatible with TypeScript server format: { userId }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyJwtPayload {
    pub user_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    pub exp: i64,
    #[serde(default)]
    pub iat: Option<i64>,
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

const JWT_EXPIRY_DAYS: i64 = 180;

/// Create an HS256 JWT that expires in 180 days.
/// Uses { userId } format for compatibility.
pub fn sign_jwt(user_id: &str, secret: &str) -> String {
    let now = Utc::now().timestamp();
    let exp = now + JWT_EXPIRY_DAYS * 24 * 60 * 60;
    let payload = LegacyJwtPayload {
        user_id: user_id.to_string(),
        display_name: None,
        role: None,
        exp,
        iat: Some(now),
    };
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &payload,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("JWT encoding should not fail")
}

/// Verify an HS256 JWT and return the user_id.
/// Supports both { userId } (legacy) and { sub } (standard) formats.
pub fn verify_jwt(token: &str, secret: &str) -> Result<String, AuthError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["exp"]);

    // Try legacy { userId } format first
    if let Ok(data) = jsonwebtoken::decode::<LegacyJwtPayload>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    ) {
        return Ok(data.claims.user_id);
    }

    // Fall back to standard { sub } format
    let data = jsonwebtoken::decode::<JwtPayload>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AuthError::InvalidToken)?;

    Ok(data.claims.sub)
}

// ---------------------------------------------------------------------------
// Password hashing (bcrypt)
// ---------------------------------------------------------------------------

const BCRYPT_COST: u32 = 10;

/// Hash a password with bcrypt (cost 10).
pub fn hash_password(password: &str) -> Result<String, AuthError> {
    bcrypt::hash(password, BCRYPT_COST).map_err(|e| AuthError::Internal(e.to_string()))
}

/// Verify a plaintext password against a bcrypt hash.
pub fn verify_password(password: &str, hash: &str) -> Result<bool, AuthError> {
    bcrypt::verify(password, hash).map_err(|e| AuthError::Internal(e.to_string()))
}

// ---------------------------------------------------------------------------
// Token hashing (SHA-256)
// ---------------------------------------------------------------------------

/// Hash a token with SHA-256 and return the hex string.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// Unified bearer token verification (JWT or API token)
// ---------------------------------------------------------------------------

/// Prefix on every API token this hub mints.
pub const API_TOKEN_PREFIX: &str = "odk_";
/// Prefix webmux used. Tokens issued before the rename still authenticate;
/// the hub never mints new ones with it.
const API_TOKEN_PREFIX_LEGACY: &str = "wmx_";

/// Verify a bearer token — either an API token or a JWT.
/// Returns the user_id on success. For the paths that take a token outside the HTTP
/// routes (WebSockets, the release beacon): full access only. A scoped token reaches
/// agent runs over HTTP only.
pub fn verify_bearer_token(
    token: &str,
    db: &db::DbPool,
    jwt_secret: &str,
) -> Result<String, AuthError> {
    let auth = verify_bearer(token, db, jwt_secret)?;
    if !auth.is_full() {
        return Err(AuthError::InvalidToken);
    }
    Ok(auth.user_id)
}

/// Verify a bearer token and say how the caller authenticated: API tokens are
/// what the `offdesk` CLI (and agents driving it) use; apps hold a JWT.
fn verify_bearer(token: &str, db: &db::DbPool, jwt_secret: &str) -> Result<AuthUser, AuthError> {
    if token.starts_with(API_TOKEN_PREFIX) || token.starts_with(API_TOKEN_PREFIX_LEGACY) {
        // API token path
        let token_hash = hash_token(token);
        let conn = db
            .get()
            .map_err(|e| AuthError::Internal(format!("DB error: {e}")))?;
        let row = db::tokens::find_api_token_by_hash(&conn, &token_hash)
            .map_err(|e| AuthError::Internal(format!("DB error: {e}")))?
            .ok_or(AuthError::InvalidToken)?;

        // Check expiry
        if let Some(expires_at) = row.expires_at {
            let now = db::now_ms();
            if now > expires_at {
                return Err(AuthError::InvalidToken);
            }
        }

        // Update last_used_at (fire and forget)
        let _ = db::tokens::update_api_token_last_used(&conn, &row.id);

        Ok(AuthUser {
            user_id: row.user_id,
            api_token_name: Some(row.name),
            api_token_id: Some(row.id),
            access: row.access.filter(|access| !access.is_full()),
        })
    } else {
        // JWT path
        verify_jwt(token, jwt_secret).map(|user_id| AuthUser {
            user_id,
            api_token_name: None,
            api_token_id: None,
            access: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Axum extractor — AuthUser
// ---------------------------------------------------------------------------

/// Authenticated user extracted from the `Authorization: Bearer <token>` header.
#[derive(Debug, Clone, Default)]
pub struct AuthUser {
    pub user_id: String,
    /// Name of the API token the request carried; `None` for app sessions (JWT).
    /// Only the name is kept, never the token.
    pub api_token_name: Option<String>,
    pub api_token_id: Option<String>,
    /// A scoped token's access; None for full access (app sessions, full tokens).
    pub access: Option<offdesk_protocol::TokenAccess>,
}

impl AuthUser {
    pub fn is_full(&self) -> bool {
        self.access.is_none()
    }

    /// Whether this caller may use `scope` (full access may use any).
    pub fn allows(&self, scope: offdesk_protocol::TokenScope) -> bool {
        self.access.as_ref().is_none_or(|access| access.allows(scope))
    }

    /// Whether this caller may reach a machine: always with full access; a scoped token
    /// only its machines (production ones only when it says so).
    pub fn may_reach_machine(&self, db: &db::DbPool, machine_id: &str) -> bool {
        let Some(access) = &self.access else {
            return true;
        };
        db.get()
            .ok()
            .and_then(|conn| db::machines::find_machine_by_id(&conn, machine_id).ok().flatten())
            .is_some_and(|machine| access.allows_machine(machine_id, machine.production))
    }

    /// Records what an API token did or was refused; app sessions aren't recorded.
    pub fn audit(&self, db: &db::DbPool, action: &str, target: &str, result: &str) {
        let (Some(id), Some(name)) = (&self.api_token_id, &self.api_token_name) else {
            return;
        };
        match db.get() {
            Ok(conn) => {
                if let Err(e) =
                    db::tokens::insert_audit(&conn, &self.user_id, id, name, action, target, result)
                {
                    tracing::warn!("token audit: {}", e);
                }
            }
            Err(e) => tracing::warn!("token audit: {}", e),
        }
    }
}

/// The routes a scoped token may reach, with the scopes that open each. Everything
/// else (terminals, input, files, previews, machine settings, tokens) is refused, so a
/// new route stays closed to scoped tokens until it's added here.
fn scoped_route(
    method: &http::Method,
    path: &str,
) -> Option<&'static [offdesk_protocol::TokenScope]> {
    use offdesk_protocol::TokenScope::{self, *};
    const SEE_RUNS: &[TokenScope] = &[RunsRead, RunsAnswer, RunsApprove];
    const ANSWER: &[TokenScope] = &[RunsAnswer, RunsApprove];
    const START: &[TokenScope] = &[RunsStart];
    const CONTROL: &[TokenScope] = &[RunsAnswer, RunsApprove, RunsStart];
    const ANY: &[TokenScope] = &[RunsRead, RunsAnswer, RunsApprove, RunsStart, RunsMessage];
    match (method.as_str(), path) {
        (
            "GET",
            "/api/agent-runs" | "/api/agent-runs/{run_id}" | "/api/agent-runs/{run_id}/events",
        ) => Some(SEE_RUNS),
        ("POST", "/api/agent-runs/{run_id}/answer") => Some(ANSWER),
        ("POST", "/api/agent-runs") => Some(START),
        ("GET", "/api/machines/{machine_id}/agents") => Some(START),
        // Answering and starting take the machine's control lease, as the CLI does
        ("POST", "/api/mode/control" | "/api/mode/release") => Some(CONTROL),
        // Listed only as far as the token's machines go
        ("GET", "/api/machines") => Some(ANY),
        _ => None,
    }
}

impl FromRequestParts<crate::AppState> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AuthError::MissingAuth)?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or(AuthError::MissingAuth)?;

        let auth = verify_bearer(token, &state.db, &state.jwt_secret)?;
        if let Some(access) = &auth.access {
            let path = parts
                .extensions
                .get::<axum::extract::MatchedPath>()
                .map(|matched| matched.as_str().to_string())
                .unwrap_or_else(|| parts.uri.path().to_string());
            let opened = scoped_route(&parts.method, &path)
                .is_some_and(|scopes| scopes.iter().any(|scope| access.allows(*scope)));
            if !opened {
                let target = format!("{} {}", parts.method, parts.uri.path());
                auth.audit(&state.db, "denied", &target, "outside its scopes");
                let scopes: Vec<&str> = access.scopes.iter().map(|s| s.as_str()).collect();
                return Err(AuthError::Forbidden(format!(
                    "This token can't do that; it may only: {}",
                    scopes.join(", ")
                )));
            }
        }
        Ok(auth)
    }
}

// ---------------------------------------------------------------------------
// GitHub OAuth
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubUser {
    pub id: i64,
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GitHubTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Exchange a GitHub OAuth code for an access token, then fetch the user profile.
pub async fn exchange_github_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<GitHubUser, AuthError> {
    let client = reqwest::Client::new();

    let token_resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
        }))
        .send()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?
        .json::<GitHubTokenResponse>()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?;

    let access_token = token_resp.access_token.ok_or_else(|| {
        let msg = token_resp
            .error_description
            .or(token_resp.error)
            .unwrap_or_else(|| "no access_token".to_string());
        AuthError::Internal(format!("GitHub OAuth error: {msg}"))
    })?;

    let user: GitHubUser = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "offdesk-hub")
        .send()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?
        .error_for_status()
        .map_err(|e| AuthError::Internal(format!("GitHub API error: {e}")))?
        .json()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?;

    Ok(user)
}

// ---------------------------------------------------------------------------
// Google OAuth
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

#[derive(Deserialize)]
struct GoogleTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Exchange a Google OAuth code for an access token, then fetch the user profile.
pub async fn exchange_google_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<GoogleUser, AuthError> {
    let client = reqwest::Client::new();

    let token_resp = client
        .post("https://oauth2.googleapis.com/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?
        .json::<GoogleTokenResponse>()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?;

    let access_token = token_resp.access_token.ok_or_else(|| {
        let msg = token_resp
            .error_description
            .or(token_resp.error)
            .unwrap_or_else(|| "no access_token".to_string());
        AuthError::Internal(format!("Google OAuth error: {msg}"))
    })?;

    let user: GoogleUser = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?
        .error_for_status()
        .map_err(|e| AuthError::Internal(format!("Google API error: {e}")))?
        .json()
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?;

    Ok(user)
}

// ---------------------------------------------------------------------------
// OAuth URL helpers
// ---------------------------------------------------------------------------

/// Minimal percent-encoding for URL query values.
fn urlencoded(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                use std::fmt::Write;
                write!(out, "%{b:02X}").unwrap();
            }
        }
    }
    out
}

/// Build the GitHub OAuth authorization URL.
pub fn github_oauth_url(client_id: &str, base_url: &str, state: Option<&str>) -> String {
    let redirect_uri = format!("{base_url}/api/auth/github/callback");
    let mut query = format!(
        "client_id={}&redirect_uri={}&scope=read%3Auser",
        urlencoded(client_id),
        urlencoded(&redirect_uri)
    );
    if let Some(state) = state {
        query.push_str("&state=");
        query.push_str(&urlencoded(state));
    }
    format!("https://github.com/login/oauth/authorize?{query}")
}

/// Build the Google OAuth authorization URL.
pub fn google_oauth_url(client_id: &str, base_url: &str, state: Option<&str>) -> String {
    let redirect_uri = format!("{base_url}/api/auth/google/callback");
    let mut query = format!(
        "client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile",
        urlencoded(client_id),
        urlencoded(&redirect_uri)
    );
    if let Some(state) = state {
        query.push_str("&state=");
        query.push_str(&urlencoded(state));
    }
    format!("https://accounts.google.com/o/oauth2/v2/auth?{query}")
}

const MOBILE_OAUTH_STATE_PREFIX: &str = "mobile:";
const MOBILE_AUTH_CALLBACK_URL: &str = "offdesk://auth";

fn is_valid_mobile_callback(callback: &str) -> bool {
    callback == MOBILE_AUTH_CALLBACK_URL
}

pub fn mobile_oauth_state(callback: &str) -> Option<String> {
    if !is_valid_mobile_callback(callback) {
        return None;
    }
    Some(format!(
        "{MOBILE_OAUTH_STATE_PREFIX}{}",
        urlencoded(callback)
    ))
}

pub fn mobile_callback_from_oauth_state(state: Option<&str>) -> Option<String> {
    let encoded = state?.strip_prefix(MOBILE_OAUTH_STATE_PREFIX)?;
    let decoded = urlencoding::decode(encoded).ok()?.into_owned();
    if is_valid_mobile_callback(&decoded) {
        Some(decoded)
    } else {
        None
    }
}

pub fn oauth_success_redirect_url(base_url: &str, jwt: &str, state: Option<&str>) -> String {
    if let Some(callback) = mobile_callback_from_oauth_state(state) {
        return format!("{callback}?token={}", urlencoded(jwt));
    }
    format!("{base_url}?token={}", urlencoded(jwt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_oauth_state_round_trips_the_offdesk_callback() {
        let state = mobile_oauth_state("offdesk://auth").expect("callback should be accepted");

        assert_eq!(
            mobile_callback_from_oauth_state(Some(&state)).as_deref(),
            Some("offdesk://auth")
        );
    }

    #[test]
    fn mobile_oauth_state_rejects_non_app_callbacks() {
        assert!(mobile_oauth_state("https://evil.example/callback").is_none());
    }

    #[test]
    fn google_oauth_url_includes_state_when_present() {
        let url = google_oauth_url(
            "client id",
            "https://offdesk.example",
            Some("mobile:offdesk%3A%2F%2Fauth"),
        );

        assert!(url.contains("state=mobile%3Aoffdesk%253A%252F%252Fauth"));
    }

    #[test]
    fn oauth_success_redirect_url_uses_mobile_callback_when_state_is_valid() {
        let state = mobile_oauth_state("offdesk://auth").expect("callback should be accepted");

        assert_eq!(
            oauth_success_redirect_url("https://offdesk.example", "jwt.token", Some(&state)),
            "offdesk://auth?token=jwt.token"
        );
    }
}
