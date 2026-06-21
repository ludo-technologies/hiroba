//! Authentication / identity resolution (FR-13, §9, §7.6).
//!
//! The `hello.token` is resolved to an [`Identity`] carrying the **tenant**
//! (org) and the caller's profile. Three modes, selected at start-up by env:
//!
//!   - **guest** (default; self-host): the token is ignored and everyone joins
//!     the single configured org as a guest. No accounts, no network, no DB —
//!     keeps the self-host profile DB-less (§7.5).
//!   - **jwt** (HS256): verify a shared-secret JWT. The simplest *real* auth — a
//!     trusted edge mints Hiroba session tokens signed with `HIROBA_JWT_SECRET`.
//!     No external calls; usable by both self-host and a simple hosted deploy.
//!   - **oidc** (RS256 via JWKS): verify an OIDC token against a provider's
//!     published JWKS (`HIROBA_JWKS_URL` — Auth0/Clerk/Google/self-hosted OIDC).
//!     This is the full hosted OAuth path (§9): the OAuth dance happens at the
//!     edge and the resulting ID/access token is handed to us as `hello.token`
//!     and cryptographically verified here.
//!
//! Claims consumed: `org` (tenant id; falls back to the configured default),
//! `sub`, `name`, `color`, plus standard `exp` (always) and optional `iss`/`aud`
//! validation. The resolved `org_id` is what pins the connection to a tenant in
//! [`crate::registry`] — the §7.6 "token → org, then fix the scope" rule.

use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::Mutex;
use tracing::{debug, warn};

/// JWKS entries are cached this long before a forced refresh. A `kid` miss also
/// triggers an out-of-band refresh (key rotation), so this is just an upper
/// bound on staleness, not the only refresh trigger.
const JWKS_TTL: Duration = Duration::from_secs(3600);

/// Resolved caller identity. `sub` is the OAuth subject (None for a guest);
/// `name`/`color` are profile hints a client may still override in `hello`.
#[derive(Debug, Clone)]
pub struct Identity {
    pub org_id: String,
    /// Tenant display name from an `org_name` claim, if the issuer supplies one
    /// (used when lazily creating a hosted org). None → fall back to the id.
    pub org_name: Option<String>,
    pub sub: Option<String>,
    pub name: Option<String>,
    pub color: Option<String>,
}

/// Why a token was rejected. Both map to the `auth_failed` wire error; the
/// distinction is for logging only (we never leak detail to the client).
#[derive(Debug)]
pub enum AuthError {
    /// A token was required but none was supplied.
    Missing,
    /// A token was supplied but failed verification.
    Invalid(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Missing => write!(f, "token missing"),
            AuthError::Invalid(detail) => write!(f, "token invalid: {detail}"),
        }
    }
}

/// Claims we read out of a verified JWT. Everything is optional except what
/// `jsonwebtoken` validates structurally (`exp`, and `iss`/`aud` if configured).
#[derive(Debug, Deserialize)]
struct Claims {
    #[serde(default)]
    org: Option<String>,
    #[serde(default)]
    org_name: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
}

/// The configured authenticator. Cheap to clone (everything shared is `Arc`).
#[derive(Clone)]
pub enum Auth {
    /// Self-host guest path: token ignored, single configured org.
    Guest { org_id: String },
    /// Verify a JWT (HS256 shared secret or RS256 via JWKS).
    Jwt {
        keys: KeySource,
        validation: Arc<Validation>,
        /// Org id used when a verified token carries no `org` claim.
        default_org: String,
    },
}

/// Where verification keys come from.
#[derive(Clone)]
pub enum KeySource {
    /// HS256 symmetric secret (held inside an `Arc<DecodingKey>` since
    /// `DecodingKey` is not itself `Clone`).
    Shared(Arc<DecodingKey>),
    /// RS256 public keys fetched from a provider's JWKS endpoint.
    Jwks(JwksCache),
}

enum AuthMode {
    Guest,
    JwtHs256,
    OidcJwks,
}

impl Auth {
    /// Build the authenticator from the environment. Panics on misconfiguration
    /// (a missing secret/URL for a mode that needs one) — a boot-time failure is
    /// preferable to silently accepting everyone.
    ///
    /// Env:
    ///   - `HIROBA_AUTH`        = `guest` (default) | `jwt` | `oidc`
    ///   - `HIROBA_ORG`         = default/only org id (also the guest org)
    ///   - `HIROBA_JWT_SECRET`  = HS256 shared secret (mode `jwt`)
    ///   - `HIROBA_JWKS_URL`    = JWKS endpoint (mode `oidc`)
    ///   - `HIROBA_JWT_ISSUER`  = optional expected `iss`
    ///   - `HIROBA_JWT_AUDIENCE`= optional expected `aud`
    pub fn from_env() -> Self {
        let default_org = env::var("HIROBA_ORG").unwrap_or_else(|_| "ludo".to_string());
        let mode = env::var("HIROBA_AUTH").ok();

        match parse_auth_mode(mode.as_deref()) {
            AuthMode::Guest => Auth::Guest {
                org_id: default_org,
            },
            AuthMode::JwtHs256 => {
                let secret = env::var("HIROBA_JWT_SECRET")
                    .unwrap_or_else(|_| panic!("HIROBA_AUTH=jwt requires HIROBA_JWT_SECRET"));
                let key = DecodingKey::from_secret(secret.as_bytes());
                let validation = build_validation(Algorithm::HS256);
                Auth::Jwt {
                    keys: KeySource::Shared(Arc::new(key)),
                    validation: Arc::new(validation),
                    default_org,
                }
            }
            AuthMode::OidcJwks => {
                let url = env::var("HIROBA_JWKS_URL")
                    .unwrap_or_else(|_| panic!("HIROBA_AUTH=oidc requires HIROBA_JWKS_URL"));
                let validation = build_validation(Algorithm::RS256);
                Auth::Jwt {
                    keys: KeySource::Jwks(JwksCache::new(url)),
                    validation: Arc::new(validation),
                    default_org,
                }
            }
        }
    }

    /// Human-readable mode name for the start-up log.
    pub fn mode(&self) -> &'static str {
        match self {
            Auth::Guest { .. } => "guest",
            Auth::Jwt {
                keys: KeySource::Shared(_),
                ..
            } => "jwt(hs256)",
            Auth::Jwt {
                keys: KeySource::Jwks(_),
                ..
            } => "oidc(jwks)",
        }
    }

    /// Resolve a `hello.token` to an [`Identity`]. Guest mode never fails; JWT
    /// modes require a present, cryptographically valid, unexpired token.
    pub async fn resolve(&self, token: Option<&str>) -> Result<Identity, AuthError> {
        match self {
            Auth::Guest { org_id } => Ok(Identity {
                org_id: org_id.clone(),
                org_name: None,
                sub: None,
                name: None,
                color: None,
            }),
            Auth::Jwt {
                keys,
                validation,
                default_org,
            } => {
                let token = token.filter(|t| !t.is_empty()).ok_or(AuthError::Missing)?;
                let claims = keys.verify(token, validation).await?;
                let org_id = claims
                    .org
                    .filter(|o| !o.is_empty())
                    .unwrap_or_else(|| default_org.clone());
                Ok(Identity {
                    org_id,
                    org_name: claims.org_name,
                    sub: claims.sub,
                    name: claims.name,
                    color: claims.color,
                })
            }
        }
    }
}

fn parse_auth_mode(mode: Option<&str>) -> AuthMode {
    match mode.map(str::trim) {
        None => AuthMode::Guest,
        Some("guest") => AuthMode::Guest,
        Some("jwt") | Some("hs256") => AuthMode::JwtHs256,
        Some("oidc") | Some("jwks") => AuthMode::OidcJwks,
        Some(other) => panic!(
            "unsupported HIROBA_AUTH={other}; expected one of: guest, jwt, hs256, oidc, jwks"
        ),
    }
}

impl KeySource {
    async fn verify(&self, token: &str, validation: &Validation) -> Result<Claims, AuthError> {
        match self {
            KeySource::Shared(key) => decode::<Claims>(token, key, validation)
                .map(|d| d.claims)
                .map_err(|e| AuthError::Invalid(e.to_string())),
            KeySource::Jwks(cache) => {
                let kid = decode_header(token)
                    .map_err(|e| AuthError::Invalid(format!("bad header: {e}")))?
                    .kid
                    .ok_or_else(|| AuthError::Invalid("token has no kid".to_string()))?;
                let key = cache.key_for(&kid).await?;
                decode::<Claims>(token, &key, validation)
                    .map(|d| d.claims)
                    .map_err(|e| AuthError::Invalid(e.to_string()))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// JWKS cache (OIDC / RS256)
// ---------------------------------------------------------------------------

/// Caches a provider's signing keys (by `kid`) so we verify locally after the
/// first fetch. A `kid` miss or staleness past [`JWKS_TTL`] forces a refetch,
/// which transparently picks up provider key rotation.
#[derive(Clone)]
pub struct JwksCache {
    url: String,
    inner: Arc<Mutex<JwksInner>>,
}

struct JwksInner {
    /// kid → (n, e) RSA components, base64url as published in the JWKS.
    keys: HashMap<String, RsaComponents>,
    fetched_at: Option<Instant>,
}

#[derive(Clone)]
struct RsaComponents {
    n: String,
    e: String,
}

/// JWKS document shape (only the fields we need).
#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kid: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
}

impl JwksCache {
    fn new(url: String) -> Self {
        Self {
            url,
            inner: Arc::new(Mutex::new(JwksInner {
                keys: HashMap::new(),
                fetched_at: None,
            })),
        }
    }

    /// Resolve a `kid` to a usable [`DecodingKey`], fetching/refreshing the JWKS
    /// if the key is unknown or the cache is stale.
    async fn key_for(&self, kid: &str) -> Result<DecodingKey, AuthError> {
        // Fast path: a fresh cache that already has the kid.
        {
            let guard = self.inner.lock().await;
            if guard.is_fresh() {
                if let Some(c) = guard.keys.get(kid) {
                    return decoding_key_from_rsa(&c.n, &c.e);
                }
            }
        }
        // Slow path: refetch (rotation or first use), then look up once more.
        self.refresh().await?;
        let guard = self.inner.lock().await;
        match guard.keys.get(kid) {
            Some(c) => decoding_key_from_rsa(&c.n, &c.e),
            None => Err(AuthError::Invalid(format!("unknown signing key: {kid}"))),
        }
    }

    async fn refresh(&self) -> Result<(), AuthError> {
        debug!(url = %self.url, "fetching JWKS");
        let jwks: Jwks = reqwest::get(&self.url)
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| AuthError::Invalid(format!("JWKS fetch failed: {e}")))?
            .json()
            .await
            .map_err(|e| AuthError::Invalid(format!("JWKS parse failed: {e}")))?;

        let mut keys = HashMap::new();
        for jwk in jwks.keys {
            if let (Some(kid), Some(n), Some(e)) = (jwk.kid, jwk.n, jwk.e) {
                keys.insert(kid, RsaComponents { n, e });
            }
        }
        if keys.is_empty() {
            warn!(url = %self.url, "JWKS contained no usable RSA keys");
        }

        let mut guard = self.inner.lock().await;
        guard.keys = keys;
        guard.fetched_at = Some(Instant::now());
        Ok(())
    }
}

impl JwksInner {
    fn is_fresh(&self) -> bool {
        self.fetched_at
            .map(|t| t.elapsed() < JWKS_TTL)
            .unwrap_or(false)
    }
}

/// Build an RS256 [`DecodingKey`] from base64url RSA modulus/exponent. Pulled
/// out as a free function so it can be unit-tested without a live JWKS.
fn decoding_key_from_rsa(n: &str, e: &str) -> Result<DecodingKey, AuthError> {
    DecodingKey::from_rsa_components(n, e)
        .map_err(|err| AuthError::Invalid(format!("bad RSA jwk: {err}")))
}

/// Common JWT validation: require `exp`; apply optional `iss`/`aud`. When no
/// audience is configured we disable `aud` validation (otherwise `jsonwebtoken`
/// rejects any token lacking the claim).
fn build_validation(alg: Algorithm) -> Validation {
    let mut validation = Validation::new(alg);
    if let Ok(iss) = env::var("HIROBA_JWT_ISSUER") {
        validation.set_issuer(&[iss]);
    }
    match env::var("HIROBA_JWT_AUDIENCE") {
        Ok(aud) => validation.set_audience(&[aud]),
        Err(_) => validation.validate_aud = false,
    }
    validation
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Serialize;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Serialize)]
    struct TestClaims {
        sub: String,
        org: String,
        name: String,
        exp: u64,
    }

    fn hs256_auth(secret: &str) -> Auth {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_aud = false;
        Auth::Jwt {
            keys: KeySource::Shared(Arc::new(DecodingKey::from_secret(secret.as_bytes()))),
            validation: Arc::new(validation),
            default_org: "fallback".to_string(),
        }
    }

    fn mint(secret: &str, claims: &TestClaims) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    fn future_exp() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600
    }

    #[test]
    #[should_panic(expected = "unsupported HIROBA_AUTH=JWT")]
    fn explicit_unknown_auth_mode_panics() {
        let _ = parse_auth_mode(Some("JWT"));
    }

    #[test]
    fn absent_auth_mode_defaults_to_guest() {
        assert!(matches!(parse_auth_mode(None), AuthMode::Guest));
    }

    #[tokio::test]
    async fn guest_ignores_token_and_uses_configured_org() {
        let auth = Auth::Guest {
            org_id: "ludo".to_string(),
        };
        let id = auth.resolve(Some("whatever")).await.unwrap();
        assert_eq!(id.org_id, "ludo");
        assert!(id.sub.is_none());
        // Absent token is fine for guest too.
        assert_eq!(auth.resolve(None).await.unwrap().org_id, "ludo");
    }

    #[tokio::test]
    async fn hs256_valid_token_yields_identity_and_org() {
        let secret = "topsecret";
        let auth = hs256_auth(secret);
        let token = mint(
            secret,
            &TestClaims {
                sub: "user-1".to_string(),
                org: "acme".to_string(),
                name: "Aoi".to_string(),
                exp: future_exp(),
            },
        );
        let id = auth.resolve(Some(&token)).await.unwrap();
        assert_eq!(id.org_id, "acme");
        assert_eq!(id.sub.as_deref(), Some("user-1"));
        assert_eq!(id.name.as_deref(), Some("Aoi"));
    }

    #[tokio::test]
    async fn hs256_missing_token_is_rejected() {
        let auth = hs256_auth("s");
        assert!(matches!(auth.resolve(None).await, Err(AuthError::Missing)));
        assert!(matches!(
            auth.resolve(Some("")).await,
            Err(AuthError::Missing)
        ));
    }

    #[tokio::test]
    async fn hs256_wrong_secret_is_rejected() {
        let token = mint(
            "right-secret",
            &TestClaims {
                sub: "u".to_string(),
                org: "acme".to_string(),
                name: "x".to_string(),
                exp: future_exp(),
            },
        );
        let auth = hs256_auth("wrong-secret");
        assert!(matches!(
            auth.resolve(Some(&token)).await,
            Err(AuthError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn hs256_expired_token_is_rejected() {
        let secret = "s";
        let token = mint(
            secret,
            &TestClaims {
                sub: "u".to_string(),
                org: "acme".to_string(),
                name: "x".to_string(),
                exp: 1, // 1970 — long expired
            },
        );
        let auth = hs256_auth(secret);
        assert!(matches!(
            auth.resolve(Some(&token)).await,
            Err(AuthError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn token_without_org_claim_falls_back_to_default() {
        // A token with no `org`: serialize a struct lacking the field.
        #[derive(Serialize)]
        struct NoOrg {
            sub: String,
            exp: u64,
        }
        let secret = "s";
        let token = encode(
            &Header::new(Algorithm::HS256),
            &NoOrg {
                sub: "u".to_string(),
                exp: future_exp(),
            },
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        let id = hs256_auth(secret).resolve(Some(&token)).await.unwrap();
        assert_eq!(id.org_id, "fallback");
    }

    #[test]
    fn rsa_jwk_parsing_rejects_garbage_without_panicking() {
        // The JWKS → DecodingKey path must surface malformed components as an
        // error (never panic / strand the connection). A real RS256 round-trip
        // is exercised by the integration setup when HIROBA_JWKS_URL is set.
        // Well-formed base64url components decode into a key.
        assert!(decoding_key_from_rsa("AQAB", "AQAB").is_ok());
        // Non-base64 input is surfaced as an error, not a panic.
        assert!(matches!(
            decoding_key_from_rsa("!!!not-base64!!!", "AQAB"),
            Err(AuthError::Invalid(_))
        ));
    }
}
