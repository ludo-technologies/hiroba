//! Desktop side of the OAuth login (AUTH_PLAN §2).
//!
//! `oauth_login` runs the whole interactive dance natively so neither the PKCE
//! verifier nor the provider code ever enters the webview:
//!
//!   1. Generate PKCE verifier/challenge + anti-CSRF state.
//!   2. Bind a loopback listener on 127.0.0.1:<random port>.
//!   3. Open the **system browser** at the auth backend's `/login/{provider}`
//!      (providers reject embedded-webview logins; AUTH_PLAN §2).
//!   4. The provider redirects to our loopback with `?code=…&state=…`.
//!   5. POST `{auth_base}/token` with code + verifier (+ optional invite);
//!      the backend exchanges with the provider and mints a Hiroba JWT.
//!
//! The companion `secret_*` commands store that JWT in the OS keychain, so the
//! webview's localStorage never holds a plaintext credential.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

/// How long we wait for the user to finish the consent screen.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

/// What the webview gets back: either a full session (token + claims) or a
/// pending org-setup handoff (`pending: "org_setup"` + provisional token, for
/// first-time users who must name their org via `POST /orgs`).
#[derive(Debug, Serialize)]
pub struct LoginResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    pub claims: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisional_token: Option<String>,
}

#[tauri::command]
pub async fn oauth_login(
    auth_base: String,
    provider: String,
    invite: Option<String>,
) -> Result<LoginResult, String> {
    let auth_base = auth_base.trim_end_matches('/').to_string();
    if !auth_base.starts_with("http://") && !auth_base.starts_with("https://") {
        return Err("auth server URL must be http(s)".into());
    }

    // ── PKCE + state ───────────────────────────────────────────────────────
    let verifier = random_b64(32); // 43 chars, within RFC 7636's 43–128
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);

    // ── Loopback receiver ──────────────────────────────────────────────────
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("cannot bind loopback listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    // ── System browser → backend → provider consent ───────────────────────
    let login_url =
        format!("{auth_base}/login/{provider}?port={port}&challenge={challenge}&state={state}");
    open::that_detached(&login_url).map_err(|e| format!("cannot open browser: {e}"))?;

    // ── Wait for the provider redirect ─────────────────────────────────────
    let code = timeout(LOGIN_TIMEOUT, wait_for_code(&listener, &state))
        .await
        .map_err(|_| "login timed out — no response from the browser".to_string())??;

    // ── Code → Hiroba JWT via the backend ─────────────────────────────────
    let http = reqwest::Client::new();
    let res = http
        .post(format!("{auth_base}/token"))
        .json(&serde_json::json!({
            "provider": provider,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
            "invite": invite,
        }))
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("login rejected ({status}): {body}"));
    }
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("bad token response: {e}"))?;

    // First-time users without an invite get a provisional token instead of a
    // session: pass the org-setup handoff through to the webview untouched.
    if body["pending"].as_str() == Some("org_setup") {
        let provisional = body["provisional_token"]
            .as_str()
            .ok_or("pending response missing provisional_token")?
            .to_string();
        return Ok(LoginResult {
            token: None,
            refresh_token: None,
            claims: serde_json::Value::Null,
            pending: Some("org_setup".to_string()),
            provisional_token: Some(provisional),
        });
    }

    let token = body["token"]
        .as_str()
        .ok_or("token response missing token")?
        .to_string();
    let refresh_token = body["refresh_token"]
        .as_str()
        .ok_or("token response missing refresh_token")?
        .to_string();
    Ok(LoginResult {
        token: Some(token),
        refresh_token: Some(refresh_token),
        claims: body["claims"].clone(),
        pending: None,
        provisional_token: None,
    })
}

/// Accept loopback connections until one carries `/callback` with our state;
/// answer every request with a tiny page so the browser tab isn't left hanging.
async fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("loopback accept failed: {e}"))?;
        match handle_callback(stream, expected_state).await {
            CallbackOutcome::Code(code) => return Ok(code),
            CallbackOutcome::Denied(reason) => return Err(format!("login refused: {reason}")),
            // Favicon probes, state mismatches, unrelated paths: keep waiting.
            CallbackOutcome::Ignored => continue,
        }
    }
}

enum CallbackOutcome {
    Code(String),
    Denied(String),
    Ignored,
}

async fn handle_callback(mut stream: TcpStream, expected_state: &str) -> CallbackOutcome {
    // Read just the request head; the request line is all we need.
    let mut buf = vec![0u8; 4096];
    let n = match timeout(Duration::from_secs(5), stream.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => return CallbackOutcome::Ignored,
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    let Some(target) = head.split_whitespace().nth(1) else {
        return CallbackOutcome::Ignored;
    };

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    if path != "/callback" {
        let _ = respond(&mut stream, 404, "Not found.").await;
        return CallbackOutcome::Ignored;
    }

    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = percent_decode(v);
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            "error" => error = Some(v),
            _ => {}
        }
    }

    if let Some(err) = error {
        let _ = respond(&mut stream, 200, "Login canceled. You can close this tab.").await;
        return CallbackOutcome::Denied(err);
    }
    if state.as_deref() != Some(expected_state) {
        let _ = respond(&mut stream, 400, "State mismatch.").await;
        return CallbackOutcome::Ignored;
    }
    match code {
        Some(code) if !code.is_empty() => {
            let _ = respond(
                &mut stream,
                200,
                "Login complete. You can close this tab and return to Hiroba.",
            )
            .await;
            CallbackOutcome::Code(code)
        }
        _ => {
            let _ = respond(&mut stream, 400, "Missing code.").await;
            CallbackOutcome::Ignored
        }
    }
}

async fn respond(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let body = format!(
        "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\">\
         <title>Hiroba</title>\
         <body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#faf6ef;color:#3a2e20\">\
         <p style=\"font-size:1.1rem\">{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn random_b64(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// OS keychain storage (AUTH_PLAN §2/§6-7: no plaintext localStorage)
// ---------------------------------------------------------------------------

// Debug builds get their own service so a dev sign-in (against a local auth
// server) never leaks into an installed release build, mirroring the
// dev-identifier WebView-storage isolation in tauri.dev.conf.json.
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "org.hiroba.app.dev";
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "org.hiroba.app";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_save(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_load(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_common_escapes() {
        assert_eq!(percent_decode("4%2F0Af-x"), "4/0Af-x");
        assert_eq!(percent_decode("a%3Db+c"), "a=b c");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("bad%zz"), "bad%zz"); // malformed → literal
    }
}
