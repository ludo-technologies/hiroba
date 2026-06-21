//! Hiroba desktop client shell.
//!
//! The client is deliberately thin: all presence, rendering, and WebRTC logic
//! lives in the WebView (TypeScript). This Rust layer hosts the OS WebView and
//! the few things a webview cannot do safely (NFR-02, NFR-09):
//!   - the interactive OAuth login (system browser + loopback + PKCE), and
//!   - OS-keychain storage for the resulting session token (AUTH_PLAN §2).

mod oauth;

/// Open a URL in the user's default browser. The webview can't navigate away
/// from the app, so the billing flow (Stripe Customer Portal) and any other
/// external link hand off here. Restricted to http(s) so a malformed URL can't
/// launch an arbitrary local handler.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("refusing to open a non-http(s) URL".into());
    }
    open::that_detached(&url).map_err(|e| format!("cannot open browser: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            oauth::oauth_login,
            oauth::secret_save,
            oauth::secret_load,
            oauth::secret_delete,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hiroba");
}
