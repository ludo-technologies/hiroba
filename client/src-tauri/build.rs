fn main() {
    // ScreenCaptureKit (sysaudio.rs) exists from macOS 12.3; the app supports
    // 12.0, so the framework is weak-linked and the shell checks the OS version
    // before touching it. The binding crate links it normally; the weak flag
    // for the same framework wins.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    }
    tauri_build::build()
}
