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

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

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

/// Whether the app may capture the whole display. On macOS this is the TCC
/// "Screen & System Audio Recording" grant: without it ScreenCaptureKit does
/// not fail — it silently hands getDisplayMedia black frames — so the webview
/// preflights here before opening the picker. A first-ever call triggers the
/// one-time OS prompt, but macOS only applies a fresh grant after the app
/// relaunches, so `false` means "send the user to System Settings", not
/// "retry".
#[tauri::command]
fn screen_capture_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        unsafe {
            if CGPreflightScreenCaptureAccess() {
                return true;
            }
            CGRequestScreenCaptureAccess()
        }
    }
    #[cfg(not(target_os = "macos"))]
    true
}

/// Deep-link into System Settings → Privacy & Security → Screen Recording so
/// the user can flip the switch for Hiroba. `open_external` is deliberately
/// http(s)-only, so the settings scheme gets its own hardcoded command rather
/// than a loosened check. No-op off macOS.
#[tauri::command]
fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open::that_detached(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        )
        .map_err(|e| format!("cannot open System Settings: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
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
            show_main_window(app);
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
                };

                let open = MenuItem::with_id(app, "open", "Open Hiroba", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Hiroba", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;

                TrayIconBuilder::new()
                    .icon(app.default_window_icon().expect("application icon").clone())
                    .tooltip("Hiroba")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // Windows/Linux resolve hiroba:// via a registry/.desktop entry
            // that points at the binary's current path; AppImages move around,
            // so (re-)register on every launch. macOS reads the scheme from
            // Info.plist — nothing to do at runtime.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            Ok(())
        })
        .on_window_event(|_window, event| {
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            oauth::oauth_login,
            oauth::secret_save,
            oauth::secret_load,
            oauth::secret_delete,
            open_external,
            screen_capture_permission,
            open_screen_recording_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Hiroba")
        .run(|_app, _event| {
            // macOS re-delivers a Dock-icon click as Reopen; the window is
            // hidden (not closed) at that point, so just bring it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main_window(_app);
            }
        });
}
