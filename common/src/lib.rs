//! Helpers shared across Hiroba binaries. Anything that must behave identically
//! wherever it is used (today: CORS configuration) lives here so a fix lands in
//! every consumer at once.

use http::HeaderValue;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

/// Build a [`CorsLayer`] from a comma-separated origin allow-list env var.
///
/// - Unset or empty → permissive `Any` (dev / self-host default, where the
///   Tauri webview reaches the server directly).
/// - Set → only the listed origins are allowed. The list must include the
///   desktop webview origins (`tauri://localhost`, `http://tauri.localhost`)
///   or desktop clients lose CORS-gated fetches such as `GET /ice`.
///
/// Fail-closed: an entry that does not parse as an origin is a configuration
/// error and **panics at startup** — silently dropping it (or falling back to
/// `Any`) would leave the operator believing CORS is restricted when it isn't.
pub fn cors_from_env(var: &str) -> CorsLayer {
    let layer = CorsLayer::new().allow_methods(Any).allow_headers(Any);
    match std::env::var(var) {
        Ok(raw) if !raw.trim().is_empty() => {
            let origins: Vec<HeaderValue> = raw
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    // An Origin header is exactly `scheme://host[:port]` — no
                    // whitespace, no path, no trailing slash. Anything else
                    // would never match a real request, i.e. it is a typo.
                    let host = s.split_once("://").map(|(_, h)| h);
                    let valid = matches!(host, Some(h) if !h.is_empty() && !h.contains('/'))
                        && !s.contains(char::is_whitespace);
                    valid
                        .then(|| s.parse().ok())
                        .flatten()
                        .unwrap_or_else(|| {
                            panic!("{var}: invalid origin {s:?} — fix the allow-list and restart")
                        })
                })
                .collect();
            if origins.is_empty() {
                panic!("{var} is set but contains no origins — unset it or list at least one");
            }
            info!(%var, count = origins.len(), "CORS restricted to configured origins");
            layer.allow_origin(origins)
        }
        _ => layer.allow_origin(Any),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test uses its own env var name: cargo runs tests concurrently and
    // process-global env mutations would otherwise race.

    #[test]
    fn unset_is_permissive() {
        let _ = cors_from_env("HIROBA_TEST_CORS_UNSET");
    }

    #[test]
    fn valid_list_is_accepted() {
        std::env::set_var(
            "HIROBA_TEST_CORS_VALID",
            "https://hiroba.example, tauri://localhost",
        );
        let _ = cors_from_env("HIROBA_TEST_CORS_VALID");
    }

    #[test]
    #[should_panic(expected = "invalid origin")]
    fn invalid_origin_fails_startup() {
        std::env::set_var("HIROBA_TEST_CORS_INVALID", "https://ok.example, bad origin");
        let _ = cors_from_env("HIROBA_TEST_CORS_INVALID");
    }

    #[test]
    #[should_panic(expected = "no origins")]
    fn separators_only_fails_startup() {
        std::env::set_var("HIROBA_TEST_CORS_EMPTYLIST", " , ,, ");
        let _ = cors_from_env("HIROBA_TEST_CORS_EMPTYLIST");
    }
}
