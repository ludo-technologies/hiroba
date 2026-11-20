//! System audio for screen share on macOS.
//!
//! WKWebView's `getDisplayMedia` never carries audio — WebKit has no
//! system-audio path and does not plan one — so the shell captures it with
//! ScreenCaptureKit and hands raw PCM to the webview, which turns it into a
//! MediaStreamTrack through an AudioWorklet (sysaudio.ts) and sends it beside
//! the screen video.
//!
//! The stream is audio-only in practice: a 2×2 px, 1 fps video config keeps
//! the compositor idle and only the audio output is attached. The app's own
//! playback is excluded, so the voices of the people watching are not sent
//! back to them.
//!
//! Transport is pull-based: `system_audio_read` blocks until PCM is queued
//! and returns it raw over the IPC protocol — one round trip per chunk, no
//! JSON. Each capture has an id that its reads and its stop are bound to: a
//! share cancelled while its capture was starting, then started again, must
//! not have the stale handle stop the capture of the share that followed.
//! Audio capture arrived with macOS 13; earlier systems get `unsupported`
//! and the screen is shared without sound.

use std::mem::{offset_of, size_of};
use std::ptr::{null_mut, NonNull};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatLinearPCM, AudioBuffer,
    AudioBufferList,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime,
};
use objc2_foundation::{
    NSArray, NSError, NSObject, NSObjectProtocol, NSOperatingSystemVersion, NSProcessInfo,
};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType,
};
use serde::Serialize;

/// Error the webview checks for: the OS is too old, share without sound.
pub const UNSUPPORTED: &str = "unsupported";

/// What the stream is asked for; a buffer in any other format fails the
/// capture rather than being decoded by guesswork.
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u32 = 2;

/// Chunks queued for the reader before new ones are dropped. ScreenCaptureKit
/// delivers about a hundred buffers a second, so this is well under a second
/// of audio: a reader that stalls for longer hears a gap, not a growing delay.
const QUEUE_CHUNKS: usize = 64;
/// How long a read waits before answering with nothing, so the webview's
/// pump loop can notice the share ended.
const READ_TIMEOUT: Duration = Duration::from_millis(300);
/// Queued chunks are coalesced into one answer up to this size: a reader
/// catching up spends one round trip, not one per chunk.
const READ_MAX_BYTES: usize = 64 * 1024;
/// ScreenCaptureKit's completion handlers normally answer within a few
/// hundred milliseconds.
const SETUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Sample format the webview builds its worklet for, and the capture's id.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    pub id: u64,
    pub sample_rate: u32,
    pub channels: u32,
}

struct Ivars {
    tx: SyncSender<Vec<u8>>,
    /// Set once the stream stopped on its own or delivered a buffer in a
    /// format we do not decode: the next read reports it and the webview
    /// drops the track instead of sending silence.
    failure: Mutex<Option<String>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; AudioOutput has no Drop.
    #[unsafe(super(NSObject))]
    #[name = "HirobaSystemAudioOutput"]
    #[ivars = Ivars]
    struct AudioOutput;

    unsafe impl NSObjectProtocol for AudioOutput {}

    unsafe impl SCStreamOutput for AudioOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(&self, _stream: &SCStream, sample_buffer: &CMSampleBuffer, kind: SCStreamOutputType) {
            if kind.0 != SCStreamOutputType::Audio.0 {
                return;
            }
            match interleaved_pcm(sample_buffer) {
                // A full queue means the reader stalled; dropping keeps the
                // delay bounded (see QUEUE_CHUNKS).
                Ok(bytes) => drop(self.ivars().tx.try_send(bytes)),
                Err(message) => self.fail(message),
            }
        }
    }

    unsafe impl SCStreamDelegate for AudioOutput {
        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop(&self, _stream: &SCStream, error: &NSError) {
            self.fail(error.localizedDescription().to_string());
        }
    }
);

impl AudioOutput {
    fn new(tx: SyncSender<Vec<u8>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { tx, failure: Mutex::new(None) });
        unsafe { msg_send![super(this), init] }
    }

    fn fail(&self, message: String) {
        let mut failure = self.ivars().failure.lock().unwrap();
        if failure.is_none() {
            eprintln!("[sysaudio] capture failed: {message}");
            *failure = Some(message);
        }
    }

    fn failure(&self) -> Option<String> {
        self.ivars().failure.lock().unwrap().clone()
    }
}

struct Capture {
    stream: Retained<SCStream>,
    output: Retained<AudioOutput>,
    /// Its own lock so a blocked read never holds up `stop`.
    rx: Arc<Mutex<Receiver<Vec<u8>>>>,
}

// SAFETY: the Retained pointers only move between tokio workers; SCStream's
// start/stop are callable from any thread, and the output object's state is
// a channel sender and a mutex.
unsafe impl Send for Capture {}

/// A Retained that crosses from a ScreenCaptureKit completion queue to the
/// thread that asked. SAFETY (of the impl): the object is only used after the
/// handoff, from one thread at a time.
struct SendRetained<T>(Retained<T>);
unsafe impl<T> Send for SendRetained<T> {}

/// Managed state: the capture, while a share with sound is on, under its id.
/// Held for the whole of a start, so starts serialise and a read or stop sees
/// either the capture before or the one after, never a half-built one.
#[derive(Default)]
pub struct SystemAudio(Arc<Mutex<Slot>>);

#[derive(Default)]
struct Slot {
    next_id: u64,
    capture: Option<(u64, Capture)>,
}

fn supported() -> bool {
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
        majorVersion: 13,
        minorVersion: 0,
        patchVersion: 0,
    })
}

/// Start capturing. A capture still running (the webview reloaded mid-share)
/// is replaced.
#[tauri::command]
pub async fn system_audio_start(state: tauri::State<'_, SystemAudio>) -> Result<Format, String> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || start(&slot))
        .await
        .map_err(|e| e.to_string())?
}

/// The next queued PCM (f32 interleaved, native endian, `Format` above), or
/// nothing after `READ_TIMEOUT`. Errors once capture `id` has stopped, failed,
/// or been replaced.
#[tauri::command]
pub async fn system_audio_read(
    state: tauri::State<'_, SystemAudio>,
    id: u64,
) -> Result<tauri::ipc::Response, String> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || read(&slot, id))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

/// Stop capture `id`. A stale id — its capture already replaced — is a no-op.
#[tauri::command]
pub async fn system_audio_stop(state: tauri::State<'_, SystemAudio>, id: u64) -> Result<(), String> {
    let slot = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || stop(&slot, id))
        .await
        .map_err(|e| e.to_string())
}

fn start(slot: &Mutex<Slot>) -> Result<Format, String> {
    if !supported() {
        return Err(UNSUPPORTED.into());
    }
    let mut slot = slot.lock().unwrap();
    if let Some((_, previous)) = slot.capture.take() {
        stop_capture(previous);
    }

    let display = first_display()?;
    // The display only feeds the (discarded) video; audio is system-wide.
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display.0,
            &NSArray::new(),
        )
    };
    let config = unsafe { SCStreamConfiguration::init(SCStreamConfiguration::alloc()) };
    unsafe {
        config.setWidth(2);
        config.setHeight(2);
        config.setMinimumFrameInterval(CMTime::new(1, 1));
        config.setShowsCursor(false);
        config.setCapturesAudio(true);
        config.setExcludesCurrentProcessAudio(true);
        config.setSampleRate(SAMPLE_RATE as isize);
        config.setChannelCount(CHANNELS as isize);
    }

    let (tx, rx) = sync_channel(QUEUE_CHUNKS);
    let output = AudioOutput::new(tx);
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &config,
            Some(ProtocolObject::from_ref(&*output)),
        )
    };
    let queue = DispatchQueue::new("org.hiroba.system-audio", None);
    unsafe {
        stream.addStreamOutput_type_sampleHandlerQueue_error(
            ProtocolObject::from_ref(&*output),
            SCStreamOutputType::Audio,
            Some(&queue),
        )
    }
    .map_err(|e| e.localizedDescription().to_string())?;
    await_completion(|done| unsafe { stream.startCaptureWithCompletionHandler(Some(&done)) })?;

    let id = slot.next_id;
    slot.next_id += 1;
    slot.capture = Some((id, Capture { stream, output, rx: Arc::new(Mutex::new(rx)) }));
    Ok(Format { id, sample_rate: SAMPLE_RATE, channels: CHANNELS })
}

fn read(slot: &Mutex<Slot>, id: u64) -> Result<Vec<u8>, String> {
    let rx = {
        let guard = slot.lock().unwrap();
        let capture = match &guard.capture {
            Some((current, capture)) if *current == id => capture,
            _ => return Err("not capturing".into()),
        };
        if let Some(failure) = capture.output.failure() {
            return Err(failure);
        }
        capture.rx.clone()
    };
    let rx = rx.lock().unwrap();
    let mut out = match rx.recv_timeout(READ_TIMEOUT) {
        Ok(chunk) => chunk,
        Err(RecvTimeoutError::Timeout) => return Ok(Vec::new()),
        Err(RecvTimeoutError::Disconnected) => return Err("capture ended".into()),
    };
    while out.len() < READ_MAX_BYTES {
        match rx.try_recv() {
            Ok(chunk) => out.extend_from_slice(&chunk),
            Err(_) => break,
        }
    }
    Ok(out)
}

fn stop(slot: &Mutex<Slot>, id: u64) {
    let mut guard = slot.lock().unwrap();
    if guard.capture.as_ref().is_some_and(|(current, _)| *current == id) {
        let (_, capture) = guard.capture.take().unwrap();
        stop_capture(capture);
    }
}

fn stop_capture(capture: Capture) {
    if let Err(e) =
        await_completion(|done| unsafe { capture.stream.stopCaptureWithCompletionHandler(Some(&done)) })
    {
        eprintln!("[sysaudio] stop: {e}");
    }
}

/// The main display, from the shareable-content query the permission preflight
/// (lib.rs) has already cleared.
fn first_display() -> Result<SendRetained<SCDisplay>, String> {
    let (tx, rx) = sync_channel::<Result<SendRetained<SCDisplay>, String>>(1);
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let result = if content.is_null() {
            Err(describe(error, "no shareable content"))
        } else {
            unsafe { (*content).displays() }
                .firstObject()
                .map(SendRetained)
                .ok_or_else(|| "no display to capture".to_string())
        };
        drop(tx.send(result));
    });
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, true, &handler,
        )
    };
    rx.recv_timeout(SETUP_TIMEOUT)
        .map_err(|_| "timed out listing displays".to_string())?
}

/// Run a ScreenCaptureKit call that reports through an `NSError*` completion
/// handler, and wait for it.
fn await_completion(call: impl FnOnce(RcBlock<dyn Fn(*mut NSError)>)) -> Result<(), String> {
    let (tx, rx) = sync_channel::<Result<(), String>>(1);
    let done = RcBlock::new(move |error: *mut NSError| {
        let result = if error.is_null() { Ok(()) } else { Err(describe(error, "")) };
        drop(tx.send(result));
    });
    call(done);
    rx.recv_timeout(SETUP_TIMEOUT)
        .map_err(|_| "timed out waiting for ScreenCaptureKit".to_string())?
}

fn describe(error: *mut NSError, fallback: &str) -> String {
    if error.is_null() {
        fallback.to_string()
    } else {
        unsafe { &*error }.localizedDescription().to_string()
    }
}

/// The sample buffer's PCM as interleaved f32 frames, native endian.
/// ScreenCaptureKit delivers planar f32 at the configured rate and channel
/// count; anything else is an error, not a guess.
fn interleaved_pcm(sample_buffer: &CMSampleBuffer) -> Result<Vec<u8>, String> {
    let description = unsafe { sample_buffer.format_description() }
        .ok_or("sample buffer without a format description")?;
    let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&description) };
    if asbd.is_null() {
        return Err("sample buffer without a stream description".into());
    }
    let asbd = unsafe { &*asbd };
    let channels = asbd.mChannelsPerFrame as usize;
    if asbd.mFormatID != kAudioFormatLinearPCM
        || asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0
        || asbd.mBitsPerChannel != 32
        || asbd.mSampleRate as u32 != SAMPLE_RATE
        || channels != CHANNELS as usize
    {
        return Err(format!(
            "unexpected audio format: id {:#x}, flags {:#x}, {} bits, {} Hz, {} channels",
            asbd.mFormatID, asbd.mFormatFlags, asbd.mBitsPerChannel, asbd.mSampleRate, channels
        ));
    }
    let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;

    // The buffer list is variable-length (one AudioBuffer per plane), so ask
    // for its size first and lay it out in our own allocation.
    let mut needed = 0usize;
    let status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            &mut needed, null_mut(), 0, None, None, 0, null_mut(),
        )
    };
    if status != 0 {
        return Err(format!("CMSampleBufferGetAudioBufferList size: {status}"));
    }
    let mut storage = vec![0u64; needed.div_ceil(size_of::<u64>())];
    let mut block: *mut CMBlockBuffer = null_mut();
    let status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            null_mut(), storage.as_mut_ptr().cast::<AudioBufferList>(), needed, None, None, 0, &mut block,
        )
    };
    if status != 0 {
        return Err(format!("CMSampleBufferGetAudioBufferList: {status}"));
    }
    // The block buffer keeps the sample memory alive; released on return.
    let _block = NonNull::new(block).map(|p| unsafe { CFRetained::from_raw(p) });

    let base = storage.as_ptr().cast::<u8>();
    let count = unsafe { (*base.cast::<AudioBufferList>()).mNumberBuffers } as usize;
    let planes = if planar { channels } else { 1 };
    if count < planes {
        return Err(format!("audio buffer list has {count} buffers, expected {planes}"));
    }
    // Buffers follow the header back to back; indexed from the allocation's
    // base so the pointers stay within it (mBuffers is declared as one).
    let buffer = |i: usize| unsafe {
        &*base.add(offset_of!(AudioBufferList, mBuffers) + i * size_of::<AudioBuffer>()).cast::<AudioBuffer>()
    };
    if !planar {
        let b = buffer(0);
        let bytes = unsafe { std::slice::from_raw_parts(b.mData.cast::<u8>(), b.mDataByteSize as usize) };
        return Ok(bytes.to_vec());
    }
    let frames = buffer(0).mDataByteSize as usize / size_of::<f32>();
    let mut out = Vec::with_capacity(frames * channels * size_of::<f32>());
    let planes: Vec<&[f32]> = (0..channels)
        .map(|c| {
            let b = buffer(c);
            unsafe { std::slice::from_raw_parts(b.mData.cast::<f32>(), b.mDataByteSize as usize / size_of::<f32>()) }
        })
        .collect();
    for frame in 0..frames {
        for plane in &planes {
            out.extend_from_slice(&plane.get(frame).copied().unwrap_or(0.0).to_ne_bytes());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captures a second of system audio on this Mac and prints what came.
    /// Needs the Screen Recording grant for the terminal running it, so it is
    /// run by hand: `cargo test -- --ignored --nocapture captures_system_audio`.
    /// The app's preflight goes first, as before a share: the first run puts
    /// up the OS prompt, and a grant takes effect once the terminal relaunches.
    #[test]
    #[ignore]
    fn captures_system_audio() {
        assert!(
            crate::screen_capture_permission(),
            "no Screen Recording grant: allow the terminal under System Settings › Privacy & Security › Screen & System Audio Recording, relaunch it, and run again"
        );
        let slot = Mutex::new(Slot::default());
        let format = start(&slot).expect("start");
        assert_eq!((format.sample_rate, format.channels), (SAMPLE_RATE, CHANNELS));
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let (mut bytes, mut reads, mut peak) = (0usize, 0u32, 0f32);
        while std::time::Instant::now() < deadline {
            let chunk = read(&slot, format.id).expect("read");
            reads += 1;
            bytes += chunk.len();
            for sample in chunk.chunks_exact(4) {
                peak = peak.max(f32::from_ne_bytes(sample.try_into().unwrap()).abs());
            }
        }
        // A second start replaces the first; the first's handle is then dead
        // and its stop leaves the second alone.
        let second = start(&slot).expect("second start");
        assert_ne!(second.id, format.id);
        assert!(read(&slot, format.id).is_err(), "a replaced capture's reads fail");
        stop(&slot, format.id);
        assert!(read(&slot, second.id).is_ok(), "a stale stop leaves the new capture running");
        stop(&slot, second.id);
        assert!(read(&slot, second.id).is_err(), "reads fail once stopped");
        let seconds = bytes as f32 / (SAMPLE_RATE * CHANNELS * 4) as f32;
        println!("{reads} reads, {bytes} bytes = {seconds:.2}s of audio, peak {peak:.3}");
        assert!(seconds > 0.5, "a second of capture yielded {seconds:.2}s");
    }
}
