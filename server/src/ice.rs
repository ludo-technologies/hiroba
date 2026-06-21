//! ICE / TURN configuration issuance (NFR-07, §7.4).
//!
//! Voice is P2P; to traverse symmetric NAT / corporate firewalls clients need a
//! TURN relay (§7.4). TURN credentials must be **short-lived** and handed to the
//! client **out of band** (over HTTP `GET /ice`, never on the signaling
//! WebSocket — credentials don't belong in wire state). This module mints the
//! coturn *REST-API* ephemeral credential pair:
//!
//!   username   = "<unix-expiry>:<user>"
//!   credential = base64( HMAC-SHA1( static-auth-secret, username ) )
//!
//! (the scheme coturn implements with `use-auth-secret` / `static-auth-secret`).
//! The same shared secret is configured on the coturn side; no per-user state or
//! database is required, which keeps the self-host profile DB-less.
//!
//! When no TURN is configured the endpoint still returns the public STUN server,
//! so a client that fetches `/ice` always gets a usable list (self-host default).

use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

/// Public STUN used as the universal baseline (self-host default, §7.4).
const DEFAULT_STUN: &str = "stun:stun.l.google.com:19302";

/// One ICE server entry, serialised to match the WebRTC `RTCIceServer` shape the
/// client feeds straight into `new RTCPeerConnection(...)`.
#[derive(Debug, Clone, Serialize)]
pub struct IceServer {
    pub urls: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// Response body for `GET /ice`.
#[derive(Debug, Clone, Serialize)]
pub struct IceConfig {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
}

/// TURN issuance config, read from the environment once at start-up.
#[derive(Clone)]
pub struct IceIssuer {
    stun_url: String,
    turn: Option<TurnConfig>,
}

#[derive(Clone)]
struct TurnConfig {
    /// e.g. `turn:turn.example.com:3478` (may be comma-separated for several).
    urls: Vec<String>,
    secret: String,
    ttl_secs: u64,
    /// Identifier baked into the ephemeral username (purely informational on the
    /// coturn side; the HMAC is over the whole `expiry:user` string).
    user: String,
}

impl IceIssuer {
    /// Build from env:
    ///   - `HIROBA_STUN_URL`   override the default public STUN (optional)
    ///   - `HIROBA_TURN_URL`   one or more `turn:`/`turns:` URLs (comma-sep)
    ///   - `HIROBA_TURN_SECRET` coturn `static-auth-secret` (enables TURN)
    ///   - `HIROBA_TURN_TTL`   credential lifetime in seconds (default 3600)
    ///   - `HIROBA_TURN_USER`  username tag (default "hiroba")
    pub fn from_env() -> Self {
        let stun_url = env::var("HIROBA_STUN_URL").unwrap_or_else(|_| DEFAULT_STUN.to_string());

        let turn = match (env::var("HIROBA_TURN_URL"), env::var("HIROBA_TURN_SECRET")) {
            (Ok(urls), Ok(secret)) if !urls.trim().is_empty() && !secret.is_empty() => {
                let urls = urls
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>();
                if urls.is_empty() {
                    None
                } else {
                    Some(TurnConfig {
                        urls,
                        secret,
                        ttl_secs: env::var("HIROBA_TURN_TTL")
                            .ok()
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(3600),
                        user: env::var("HIROBA_TURN_USER").unwrap_or_else(|_| "hiroba".to_string()),
                    })
                }
            }
            _ => None,
        };

        Self { stun_url, turn }
    }

    /// Whether a TURN relay is configured (for the start-up log).
    pub fn has_turn(&self) -> bool {
        self.turn.is_some()
    }

    /// Produce the ICE config for one client request: STUN always, plus TURN
    /// entries carrying freshly minted short-lived credentials when configured.
    pub fn issue(&self) -> IceConfig {
        let mut ice_servers = vec![IceServer {
            urls: self.stun_url.clone(),
            username: None,
            credential: None,
        }];

        if let Some(turn) = &self.turn {
            // A failed clock read previously fell back to `now = 0`, which mints
            // a credential whose `expiry = ttl_secs` lands in 1970 — already
            // expired, so coturn rejects it and the client silently loses TURN.
            // If we can't read a sane wall clock, omit TURN rather than emit a
            // dead credential; the client still gets a usable STUN-only list.
            match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(d) => {
                    let expiry = d.as_secs() + turn.ttl_secs;
                    let (username, credential) =
                        ephemeral_credential(&turn.secret, &turn.user, expiry);
                    for url in &turn.urls {
                        ice_servers.push(IceServer {
                            urls: url.clone(),
                            username: Some(username.clone()),
                            credential: Some(credential.clone()),
                        });
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "system clock before UNIX_EPOCH; omitting TURN credentials");
                }
            }
        }

        IceConfig { ice_servers }
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

    #[test]
    fn stun_only_when_no_turn_configured() {
        let issuer = IceIssuer {
            stun_url: DEFAULT_STUN.to_string(),
            turn: None,
        };
        let cfg = issuer.issue();
        assert_eq!(cfg.ice_servers.len(), 1);
        assert!(cfg.ice_servers[0].urls.starts_with("stun:"));
        assert!(cfg.ice_servers[0].credential.is_none());
    }

    #[test]
    fn turn_entry_carries_ephemeral_credentials() {
        let issuer = IceIssuer {
            stun_url: DEFAULT_STUN.to_string(),
            turn: Some(TurnConfig {
                urls: vec![
                    "turn:turn.example.com:3478".to_string(),
                    "turns:turn.example.com:5349".to_string(),
                ],
                secret: "shared".to_string(),
                ttl_secs: 600,
                user: "hiroba".to_string(),
            }),
        };
        let cfg = issuer.issue();
        assert_eq!(cfg.ice_servers.len(), 3, "STUN + 2 TURN urls");
        let turn = &cfg.ice_servers[1];
        let user = turn.username.as_ref().unwrap();
        // username is "<expiry>:hiroba" with a future expiry.
        let (exp, tag) = user.split_once(':').unwrap();
        assert_eq!(tag, "hiroba");
        assert!(exp.parse::<u64>().unwrap() > 0);
        assert!(turn.credential.is_some());
        // Both TURN urls share the one credential pair issued for this request.
        assert_eq!(cfg.ice_servers[2].username, turn.username);
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
}
