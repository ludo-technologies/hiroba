//! Opening Hiroba when the user signs in to the computer.
//!
//! An office only has people in it while their apps are open, and nobody
//! remembers to open one every morning — so the app registers itself to start
//! at login (main.ts turns this on at the first signed-in entry; the settings
//! panel turns it off). Two mechanisms, one per kind of install:
//!
//!   - a direct install (dmg, MSI, AppImage) registers through `auto-launch`:
//!     a Launch Agent on macOS, the `Run` key on Windows, an XDG autostart
//!     entry on Linux — each starting the binary with [`LOGIN_ARG`];
//!   - a Microsoft Store install cannot use the `Run` key (its registry writes
//!     land in the package's private hive), so its manifest declares a startup
//!     task (msix/AppxManifest.xml) that is switched here through
//!     `Windows.ApplicationModel.StartupTask`. A packaged desktop app gets no
//!     consent dialog, and a task the user turned off in Task Manager or
//!     Settings cannot be turned back on from here.
//!
//! A launch at login starts minimised and walks into the office by itself
//! (`launched_at_login`, read by main.ts).

/// What a direct install's login entry passes, telling this launch apart from
/// one the user started.
const LOGIN_ARG: &str = "--autostart";

/// `TaskId` of the startup task in msix/AppxManifest.xml.
#[cfg(windows)]
const STARTUP_TASK_ID: &str = "HirobaStartup";

/// Whether the OS started this process at login rather than the user.
pub fn at_login() -> bool {
    #[cfg(windows)]
    if crate::store_managed() {
        use windows::ApplicationModel::{Activation::ActivationKind, AppInstance};

        // A startup task takes no arguments; the activation kind is the only
        // thing that tells it apart.
        return AppInstance::GetActivatedEventArgs()
            .and_then(|args| args.Kind())
            .is_ok_and(|kind| kind == ActivationKind::StartupTask);
    }
    std::env::args().any(|arg| arg == LOGIN_ARG)
}

/// The launch-at-login answer, taken once in `setup`.
pub struct LaunchedAtLogin(pub bool);

#[tauri::command]
pub fn launched_at_login(state: tauri::State<'_, LaunchedAtLogin>) -> bool {
    state.0
}

#[cfg(windows)]
mod store {
    use windows::core::{Result, HSTRING};
    use windows::ApplicationModel::{StartupTask, StartupTaskState};

    fn task() -> Result<StartupTask> {
        StartupTask::GetAsync(&HSTRING::from(super::STARTUP_TASK_ID))?.get()
    }

    fn is_on(state: StartupTaskState) -> bool {
        state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
    }

    pub fn enabled() -> Result<bool> {
        Ok(is_on(task()?.State()?))
    }

    /// The state the task ended in: asking for it on does not override a user
    /// (or a policy) that turned it off.
    pub fn set(on: bool) -> Result<bool> {
        let task = task()?;
        if on {
            Ok(is_on(task.RequestEnableAsync()?.get()?))
        } else {
            task.Disable()?;
            Ok(false)
        }
    }
}

fn login_entry() -> Result<auto_launch::AutoLaunch, String> {
    // An AppImage runs from a mount that is gone by the next login; the file
    // the user keeps is what has to be started.
    let path = match std::env::var_os("APPIMAGE") {
        Some(appimage) => std::path::PathBuf::from(appimage),
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    auto_launch::AutoLaunchBuilder::new()
        .set_app_name("Hiroba")
        .set_app_path(&path.display().to_string())
        .set_args(&[LOGIN_ARG])
        .build()
        .map_err(|e| e.to_string())
}

/// Whether Hiroba opens at login. Async so the Store path's blocking wait
/// stays off the main thread.
#[tauri::command]
pub async fn autostart_enabled() -> Result<bool, String> {
    #[cfg(windows)]
    if crate::store_managed() {
        return store::enabled().map_err(|e| e.to_string());
    }
    login_entry()?.is_enabled().map_err(|e| e.to_string())
}

/// Turn opening at login on or off; answers what it is afterwards, which on a
/// Store install is still off when the user disabled it in Windows.
#[tauri::command]
pub async fn set_autostart(enabled: bool) -> Result<bool, String> {
    #[cfg(windows)]
    if crate::store_managed() {
        return store::set(enabled).map_err(|e| e.to_string());
    }
    let entry = login_entry()?;
    if enabled {
        entry.enable().map_err(|e| e.to_string())?;
    } else if entry.is_enabled().map_err(|e| e.to_string())? {
        entry.disable().map_err(|e| e.to_string())?;
    }
    Ok(enabled)
}
