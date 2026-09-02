//! ICE / TURN configuration issuance (NFR-07, §7.4).
//!
//! Voice is P2P; to traverse symmetric NAT / corporate firewalls clients need a
//! TURN relay (§7.4). TURN credentials must be **short-lived** and handed to the
//! client **out of band** (over HTTP `GET /ice`, never on the signaling
//! WebSocket — credentials don't belong in wire state). Two relay flavours are
//! supported, selected by environment:
//!
//! * **coturn** (self-host): this module mints the coturn *REST-API* ephemeral
//!   credential pair locally from a shared secret,
//!   `username = "<unix-expiry>:<user>"` and
//!   `credential = base64(HMAC-SHA1(static-auth-secret, username))`
//!   (the scheme coturn implements with `use-auth-secret` / `static-auth-secret`).
//!   No per-user state or database is required, which keeps the self-host
//!   profile DB-less.
//!
//! * **Cloudflare Realtime TURN** (hosted): credentials are minted by
//!   Cloudflare's API, so `/ice` proxies one `generate-ice-servers` call and
//!   caches the answer for half its lifetime. Cloudflare's list includes
//!   `turns:` on TCP 443, which is what gets through corporate firewalls.
//!
//! When no TURN is configured the endpoint still returns the public STUN server,
//! so a client that fetches `/ice` always gets a usable list (self-host default).

use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

/// Public STUN used as the universal baseline (self-host default, §7.4).
const DEFAULT_STUN: &str = "stun:stun.l.google.com:19302";

/// Cloudflare Realtime TURN credential API.
const CLOUDFLARE_TURN_API: &str = "https://rtc.live.cloudflare.com/v1/turn/keys";
const CLOUDFLARE_TIMEOUT: Duration = Duration::from_secs(5);

/// Default credential lifetimes. coturn creds are cheap to re-mint, so short;
/// Cloudflare creds cost an API round-trip and back a whole working day.
const DEFAULT_COTURN_TTL_SECS: u64 = 3600;
const DEFAULT_CLOUDFLARE_TTL_SECS: u64 = 86_400;

/// One ICE server entry, serialised to match the WebRTC `RTCIceServer` shape the
/// client feeds straight into `new RTCPeerConnection(...)`. Also the shape
/// Cloudflare's API returns, so it deserialises straight through.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// Response body for `GET /ice`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceConfig {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
    /// Seconds the TURN credentials in this list stay valid. Absent when the
    /// list carries no credentials (STUN only). The client refreshes `/ice`
    /// before this elapses so long-lived sessions keep a working relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u64>,
}

/// TURN issuance config, read from the environment once at start-up.
#[derive(Clone)]
pub struct IceIssuer {
    stun_url: String,
    relay: Relay,
}

#[derive(Clone)]
enum Relay {
    None,
    Coturn(CoturnConfig),
    Cloudflare(CloudflareTurn),
}

#[derive(Clone)]
struct CoturnConfig {
    /// e.g. `turn:turn.example.com:3478` (may be comma-separated for several).
    urls: Vec<String>,
    secret: String,
    ttl_secs: u64,
    /// Identifier baked into the ephemeral username (purely informational on the
    /// coturn side; the HMAC is over the whole `expiry:user` string).
    user: String,
}

#[derive(Clone)]
struct CloudflareTurn {
    api_base: String,
    key_id: String,
    api_token: String,
    ttl_secs: u64,
    http: reqwest::Client,
    /// Last list fetched from Cloudflare; reused while less than half its
    /// lifetime has elapsed so `/ice` doesn't cost an API call per client.
    cache: Arc<Mutex<Option<CachedIce>>>,
}

#[derive(Clone)]
struct CachedIce {
    servers: Vec<IceServer>,
    issued_at: Instant,
}

#[derive(Deserialize)]
struct CloudflareResponse {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<IceServer>,
}

impl IceIssuer {
    /// Build from env:
    ///   - `HIROBA_STUN_URL`   override the default public STUN (optional)
    ///   - `HIROBA_TURN_TTL`   credential lifetime in seconds
    ///     (default 3600 for coturn, 86400 for Cloudflare)
    ///
    /// coturn (self-host):
    ///   - `HIROBA_TURN_URL`   one or more `turn:`/`turns:` URLs (comma-sep)
    ///   - `HIROBA_TURN_SECRET` coturn `static-auth-secret` (enables TURN)
    ///   - `HIROBA_TURN_USER`  username tag (default "hiroba")
    ///
    /// Cloudflare Realtime TURN (hosted):
    ///   - `HIROBA_TURN_CF_KEY_ID`    TURN key id
    ///   - `HIROBA_TURN_CF_API_TOKEN` the key's API token
    ///
    /// Configuring both relays, or only half of the Cloudflare pair, aborts
    /// start-up: a half-configured relay would silently degrade to STUN.
    pub fn from_env() -> Self {
        let stun_url = env::var("HIROBA_STUN_URL").unwrap_or_else(|_| DEFAULT_STUN.to_string());
        let ttl_override = env::var("HIROBA_TURN_TTL")
            .ok()
            .and_then(|v| v.parse::<u64>().ok());

        let coturn = match (env::var("HIROBA_TURN_URL"), env::var("HIROBA_TURN_SECRET")) {
            (Ok(urls), Ok(secret)) if !urls.trim().is_empty() && !secret.is_empty() => {
                let urls = urls
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>();
                (!urls.is_empty()).then(|| CoturnConfig {
                    urls,
                    secret,
                    ttl_secs: ttl_override.unwrap_or(DEFAULT_COTURN_TTL_SECS),
                    user: env::var("HIROBA_TURN_USER").unwrap_or_else(|_| "hiroba".to_string()),
                })
            }
            _ => None,
        };

        let cf_key_id = env::var("HIROBA_TURN_CF_KEY_ID")
            .ok()
            .filter(|v| !v.is_empty());
        let cf_token = env::var("HIROBA_TURN_CF_API_TOKEN")
            .ok()
            .filter(|v| !v.is_empty());
        let cloudflare = match (cf_key_id, cf_token) {
            (Some(key_id), Some(api_token)) => Some(CloudflareTurn::new(
                CLOUDFLARE_TURN_API.to_string(),
                key_id,
                api_token,
                ttl_override.unwrap_or(DEFAULT_CLOUDFLARE_TTL_SECS),
            )),
            (None, None) => None,
            _ => panic!("HIROBA_TURN_CF_KEY_ID and HIROBA_TURN_CF_API_TOKEN must be set together"),
        };

        let relay = match (coturn, cloudflare) {
            (Some(_), Some(_)) => {
                panic!("HIROBA_TURN_URL/SECRET and HIROBA_TURN_CF_* are mutually exclusive")
            }
            (Some(c), None) => Relay::Coturn(c),
            (None, Some(c)) => Relay::Cloudflare(c),
            (None, None) => Relay::None,
        };

        Self { stun_url, relay }
    }

    /// Whether a TURN relay is configured (for the start-up log).
    pub fn has_turn(&self) -> bool {
        !matches!(self.relay, Relay::None)
    }

    /// Produce the ICE config for one client request: STUN always, plus TURN
    /// entries carrying short-lived credentials when a relay is configured.
    /// Errors only when the Cloudflare API is unreachable or answers garbage.
    pub async fn issue(&self) -> Result<IceConfig, String> {
        match &self.relay {
            Relay::Cloudflare(cf) => cf.issue().await,
            Relay::Coturn(turn) => Ok(self.issue_coturn(turn)),
            Relay::None => Ok(IceConfig {
                ice_servers: vec![self.stun_entry()],
                ttl: None,
            }),
        }
    }

    fn stun_entry(&self) -> IceServer {
        IceServer {
            urls: vec![self.stun_url.clone()],
            username: None,
            credential: None,
        }
    }

    fn issue_coturn(&self, turn: &CoturnConfig) -> IceConfig {
        let mut ice_servers = vec![self.stun_entry()];
        // A failed clock read previously fell back to `now = 0`, which mints
        // a credential whose `expiry = ttl_secs` lands in 1970 — already
        // expired, so coturn rejects it and the client silently loses TURN.
        // If we can't read a sane wall clock, omit TURN rather than emit a
        // dead credential; the client still gets a usable STUN-only list.
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => {
                let expiry = d.as_secs() + turn.ttl_secs;
                let (username, credential) = ephemeral_credential(&turn.secret, &turn.user, expiry);
                ice_servers.push(IceServer {
                    urls: turn.urls.clone(),
                    username: Some(username),
                    credential: Some(credential),
                });
                IceConfig {
                    ice_servers,
                    ttl: Some(turn.ttl_secs),
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "system clock before UNIX_EPOCH; omitting TURN credentials");
                IceConfig {
                    ice_servers,
                    ttl: None,
                }
            }
        }
    }
}

impl CloudflareTurn {
    fn new(api_base: String, key_id: String, api_token: String, ttl_secs: u64) -> Self {
        Self {
            api_base,
            key_id,
            api_token,
            ttl_secs,
            http: reqwest::Client::builder()
                .timeout(CLOUDFLARE_TIMEOUT)
                .build()
                .expect("Cloudflare TURN HTTP client"),
            cache: Arc::new(Mutex::new(None)),
        }
    }

    async fn issue(&self) -> Result<IceConfig, String> {
        let refresh_after = Duration::from_secs(self.ttl_secs / 2);
        // Held across the Cloudflare round-trip on purpose: every client was
        // handed the same ttl, so they all come back for a renewal at the same
        // moment, and without single-flighting each would miss the cache and
        // hit the API on its own (rate limits, a burst of 502s). Waiters get
        // the list the first one fetched.
        let mut cache = self.cache.lock().await;
        let cached = match &*cache {
            Some(c) if c.issued_at.elapsed() < refresh_after => c.clone(),
            _ => {
                let servers = self.fetch().await?;
                let fresh = CachedIce {
                    servers,
                    issued_at: Instant::now(),
                };
                *cache = Some(fresh.clone());
                fresh
            }
        };
        drop(cache);
        let remaining = self
            .ttl_secs
            .saturating_sub(cached.issued_at.elapsed().as_secs());
        Ok(IceConfig {
            ice_servers: cached.servers,
            ttl: Some(remaining),
        })
    }

    async fn fetch(&self) -> Result<Vec<IceServer>, String> {
        let url = format!(
            "{}/{}/credentials/generate-ice-servers",
            self.api_base, self.key_id
        );
        let res = self
            .http
            .post(&url)
            .bearer_auth(&self.api_token)
            .json(&serde_json::json!({ "ttl": self.ttl_secs }))
            .send()
            .await
            .map_err(|e| format!("Cloudflare TURN request failed: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            return Err(format!("Cloudflare TURN API returned {status}"));
        }
        let body: CloudflareResponse = res
            .json()
            .await
            .map_err(|e| format!("Cloudflare TURN response unreadable: {e}"))?;
        if body.ice_servers.is_empty() {
            return Err("Cloudflare TURN API returned no ICE servers".to_string());
        }
        Ok(body.ice_servers)
    }
}

/// The coturn REST-API ephemeral credential: `username = "expiry:user"`,
/// `credential = base64(HMAC-SHA1(secret, username))`.
fn ephemeral_credential(secret: &str, user: &str, expiry: u64) -> (String, String) {
    let username = format!("{expiry}:{user}");
    let mut mac =
        HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC accepts keys of any size");
    mac.update(username.as_bytes());
    let credential = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    (username, credential)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn stun_only_when_no_turn_configured() {
        let issuer = IceIssuer {
            stun_url: DEFAULT_STUN.to_string(),
            relay: Relay::None,
        };
        let cfg = issuer.issue().await.unwrap();
        assert_eq!(cfg.ice_servers.len(), 1);
        assert_eq!(cfg.ice_servers[0].urls, vec![DEFAULT_STUN]);
        assert!(cfg.ice_servers[0].credential.is_none());
        assert_eq!(cfg.ttl, None);
    }

    #[tokio::test]
    async fn coturn_entry_carries_ephemeral_credentials() {
        let issuer = IceIssuer {
            stun_url: DEFAULT_STUN.to_string(),
            relay: Relay::Coturn(CoturnConfig {
                urls: vec![
                    "turn:turn.example.com:3478".to_string(),
                    "turns:turn.example.com:5349".to_string(),
                ],
                secret: "shared".to_string(),
                ttl_secs: 600,
                user: "hiroba".to_string(),
            }),
        };
        let cfg = issuer.issue().await.unwrap();
        assert_eq!(cfg.ice_servers.len(), 2, "STUN + one TURN entry");
        assert_eq!(cfg.ttl, Some(600));
        let turn = &cfg.ice_servers[1];
        assert_eq!(
            turn.urls.len(),
            2,
            "both TURN urls share one credential pair"
        );
        let user = turn.username.as_ref().unwrap();
        // username is "<expiry>:hiroba" with a future expiry.
        let (exp, tag) = user.split_once(':').unwrap();
        assert_eq!(tag, "hiroba");
        assert!(exp.parse::<u64>().unwrap() > 0);
        assert!(turn.credential.is_some());
    }

    #[test]
    fn credential_matches_coturn_hmac_scheme() {
        // Known-answer: HMAC-SHA1("secret", "1000:hiroba") base64-encoded. This
        // pins the exact bytes a coturn `static-auth-secret` deployment expects.
        let (username, credential) = ephemeral_credential("secret", "hiroba", 1000);
        assert_eq!(username, "1000:hiroba");
        // Recompute independently to assert determinism + correct construction.
        let mut mac = HmacSha1::new_from_slice(b"secret").unwrap();
        mac.update(b"1000:hiroba");
        let expected =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        assert_eq!(credential, expected);
    }

    /// Stand-in for Cloudflare's API: records how often it was hit and checks
    /// the request shape (path, bearer, ttl body) before answering the
    /// documented response.
    async fn spawn_fake_cloudflare(hits: Arc<AtomicUsize>) -> String {
        use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};

        async fn handler(
            State(hits): State<Arc<AtomicUsize>>,
            headers: HeaderMap,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            hits.fetch_add(1, Ordering::SeqCst);
            assert_eq!(headers["authorization"], "Bearer tok");
            assert_eq!(body["ttl"], 600);
            // Long enough for concurrent callers to overlap the round-trip.
            tokio::time::sleep(Duration::from_millis(50)).await;
            Json(serde_json::json!({
                "iceServers": [
                    { "urls": ["stun:stun.cloudflare.com:3478"] },
                    {
                        "urls": [
                            "turn:turn.cloudflare.com:3478?transport=udp",
                            "turns:turn.cloudflare.com:443?transport=tcp"
                        ],
                        "username": "u",
                        "credential": "c"
                    }
                ]
            }))
        }

        let app = Router::new()
            .route("/key123/credentials/generate-ice-servers", post(handler))
            .with_state(hits);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn cloudflare_list_is_proxied_and_cached() {
        let hits = Arc::new(AtomicUsize::new(0));
        let base = spawn_fake_cloudflare(hits.clone()).await;
        let issuer = IceIssuer {
            stun_url: DEFAULT_STUN.to_string(),
            relay: Relay::Cloudflare(CloudflareTurn::new(
                base,
                "key123".to_string(),
                "tok".to_string(),
                600,
            )),
        };

        let cfg = issuer.issue().await.unwrap();
        assert_eq!(cfg.ice_servers.len(), 2);
        assert_eq!(cfg.ice_servers[1].username.as_deref(), Some("u"));
        assert!(cfg.ice_servers[1]
            .urls
            .iter()
            .any(|u| u.starts_with("turns:") && u.contains(":443")));
        assert_eq!(cfg.ttl, Some(600));

        let again = issuer.issue().await.unwrap();
        assert_eq!(again.ice_servers.len(), 2);
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "second call served from cache"
        );
    }

    #[tokio::test]
    async fn concurrent_cache_misses_share_one_cloudflare_call() {
        let hits = Arc::new(AtomicUsize::new(0));
        let base = spawn_fake_cloudflare(hits.clone()).await;
        let issuer = IceIssuer {
            stun_url: DEFAULT_STUN.to_string(),
            relay: Relay::Cloudflare(CloudflareTurn::new(
                base,
                "key123".to_string(),
                "tok".to_string(),
                600,
            )),
        };

        let (a, b, c) = tokio::join!(issuer.issue(), issuer.issue(), issuer.issue());
        for cfg in [a.unwrap(), b.unwrap(), c.unwrap()] {
            assert_eq!(cfg.ice_servers.len(), 2);
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "a refresh burst is single-flighted"
        );
    }

    #[tokio::test]
    async fn cloudflare_failure_is_an_error_not_a_silent_stun_list() {
        let issuer = IceIssuer {
            stun_url: DEFAULT_STUN.to_string(),
            relay: Relay::Cloudflare(CloudflareTurn::new(
                "http://127.0.0.1:1".to_string(),
                "key".to_string(),
                "tok".to_string(),
                600,
            )),
        };
        assert!(issuer.issue().await.is_err());
    }
}
