//! Billing lock enforcement.
//!
//! The signaling server doesn't talk to Stripe — it only needs to know whether
//! an org is *locked* (trial paused, or subscription canceled/unpaid). The auth
//! backend owns that state and exposes it at `GET /billing/status/{org}`; this
//! gate queries it at connect time.
//!
//! **Opt-in**: [`BillingGate::from_env`] returns `None` unless
//! `HIROBA_BILLING_STATUS_URL` is set, so self-host (no billing) pays nothing.
//!
//! **Fail-open**: if the status endpoint is unreachable or malformed we treat
//! the org as *not* locked. A billing-service outage must not lock every tenant
//! out of an in-person presence tool; the cost is that a genuinely locked org
//! keeps working until auth recovers.

use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tracing::{debug, warn};

/// How long a status answer is trusted before we re-query. Bounds both the load
/// on the auth backend and how long a freshly-locked org lingers (§6: lock only
/// happens after Stripe's multi-day Smart Retries, so a minute of slack is fine).
const CACHE_TTL: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Per-connect lock check against the auth backend's `/billing/status`.
#[derive(Clone)]
pub struct BillingGate {
    http: reqwest::Client,
    /// Base URL, e.g. `http://127.0.0.1:8788/billing/status`; the org id is
    /// appended as a path segment.
    base_url: String,
    cache: Arc<Mutex<HashMap<String, (bool, Instant)>>>,
}

impl BillingGate {
    /// Build from `HIROBA_BILLING_STATUS_URL`, or `None` when unset (self-host).
    pub fn from_env() -> Option<Self> {
        let base_url = env::var("HIROBA_BILLING_STATUS_URL").ok()?;
        Some(Self {
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("billing status HTTP client"),
            base_url: base_url.trim_end_matches('/').to_string(),
            cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Whether `org_id` is currently locked. Cached for [`CACHE_TTL`]; fails open.
    pub async fn locked(&self, org_id: &str) -> bool {
        if let Some((locked, at)) = self.cache.lock().await.get(org_id).copied() {
            if at.elapsed() < CACHE_TTL {
                return locked;
            }
        }
        let locked = self.fetch(org_id).await;
        self.cache
            .lock()
            .await
            .insert(org_id.to_string(), (locked, Instant::now()));
        locked
    }

    /// Query the auth backend; any failure → not locked (fail-open).
    async fn fetch(&self, org_id: &str) -> bool {
        let url = format!("{}/{}", self.base_url, org_id);
        match self.http.get(&url).send().await {
            Ok(res) if res.status().is_success() => match res.json::<serde_json::Value>().await {
                Ok(body) => {
                    let locked = body["locked"].as_bool().unwrap_or(false);
                    debug!(%org_id, locked, "billing status");
                    locked
                }
                Err(e) => {
                    warn!(%org_id, error = %e, "billing status parse failed; failing open");
                    false
                }
            },
            Ok(res) => {
                warn!(%org_id, status = %res.status(), "billing status non-2xx; failing open");
                false
            }
            Err(e) => {
                warn!(%org_id, error = %e, "billing status unreachable; failing open");
                false
            }
        }
    }
}
