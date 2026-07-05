//! Hiroba desktop client shell.
//!
//! The client is deliberately thin: all presence, rendering, and WebRTC logic
//! lives in the WebView (TypeScript). This Rust layer hosts the OS WebView and
//! the few things a webview cannot do safely (NFR-02, NFR-09):
//!   - the interactive OAuth login (system browser + loopback + PKCE),
//!   - OS-keychain storage for the resulting session token (AUTH_PLAN §2), and
//!   - auto-update: signature-verified installs + relaunch (updater/process
//!     plugins; the frontend drives them from updater.ts), and
//!   - hiroba:// deep links (invite links; deep-link + single-instance
//!     plugins; the frontend consumes them in deeplink.ts).

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
    let mut builder = tauri::Builder::default();
    // Single-instance must be the first plugin registered: on Windows/Linux
    // the OS hands a hiroba:// URL to a *new* process, which forwards it to
    // the running instance (the crate's deep-link feature re-emits the URL
    // there) and exits. We just bring the existing window forward.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|_app| {
            // Windows/Linux resolve hiroba:// via a registry/.desktop entry
            // that points at the binary's current path; AppImages move around,
            // so (re-)register on every launch. macOS reads the scheme from
            // Info.plist — nothing to do at runtime.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                _app.deep_link().register_all()?;
            }
            Ok(())
        })
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
