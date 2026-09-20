//! Guest-exit beacon — what a browser guest's visit was like, not just that
//! it happened.
//!
//! The auth backend reports a guest's *entry* (it mints the session). Only
//! this server sees the *exit*: the socket closing is the one moment that knows
//! how long they stayed and whether anyone else was around while they were —
//! the difference between "walked into an empty office and left" and "stayed
//! and talked", which an arrival count cannot make. So on a guest's disconnect
//! this posts that summary to the same worker the entry went to, and the two
//! land on one row.
//!
//! Server to server, like auth's: a browser-side leave beacon is blockable and
//! flaky on tab close; a socket close is neither.
//!
//! Env (both or neither, like the billing gate's URL):
//!   - `HIROBA_GUEST_BEACON_URL`    e.g. `https://update.hirobaoffice.com/guest/left`
//!   - `HIROBA_GUEST_BEACON_SECRET` shared with the worker's `GUEST_BEACON_SECRET`
//!
//! Unset, guest exits simply are not reported — the right default for a
//! self-host, where our growth report is none of the operator's business.

use std::env;
use std::time::Duration;

use tracing::warn;

/// Short: this runs after the socket is already gone, and a summary is worth
/// a row, never a hung task.
const POST_TIMEOUT: Duration = Duration::from_secs(5);

pub struct GuestBeacon {
    url: String,
    secret: String,
    http: reqwest::Client,
}

impl GuestBeacon {
    /// Both variables or neither. Half a configuration is a typo, and a typo
    /// that silently stops counting is the failure we would notice last — so
    /// it aborts the boot.
    pub fn from_env() -> Option<Self> {
        let non_empty = |key: &str| env::var(key).ok().filter(|v| !v.trim().is_empty());
        let (url, secret) = match (
            non_empty("HIROBA_GUEST_BEACON_URL"),
            non_empty("HIROBA_GUEST_BEACON_SECRET"),
        ) {
            (Some(url), Some(secret)) => (url, secret),
            (None, None) => return None,
            (Some(_), None) => {
                panic!("HIROBA_GUEST_BEACON_URL is set but HIROBA_GUEST_BEACON_SECRET is missing or empty")
            }
            (None, Some(_)) => {
                panic!("HIROBA_GUEST_BEACON_SECRET is set but HIROBA_GUEST_BEACON_URL is missing or empty")
            }
        };
        Some(Self {
            url,
            secret,
            http: reqwest::Client::builder()
                .timeout(POST_TIMEOUT)
                .build()
                .expect("build beacon client"),
        })
    }

    /// Report one guest's exit: `secs` connected, and the most other members
    /// (`peers`) in the org at once during the stay. The name is hashing
    /// material for the worker's daily pseudonym — the same digest auth's
    /// entry report produced — and is not stored on the other side.
    ///
    /// Errors are logged, not returned: the guest is already gone and there is
    /// nothing for the caller to do about a failed count.
    pub async fn guest_left(&self, org: &str, name: &str, secs: u64, peers: usize) {
        let res = self
            .http
            .post(&self.url)
            .bearer_auth(&self.secret)
            .json(&serde_json::json!({ "org": org, "name": name, "secs": secs, "peers": peers }))
            .send()
            .await;
        match res {
            Ok(res) if res.status().is_success() => {}
            Ok(res) => warn!(status = %res.status(), "guest beacon rejected"),
            Err(err) => warn!(reason = %err, "guest beacon failed"),
        }
    }
}
