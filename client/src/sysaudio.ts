/**
 * sysaudio.ts — the Mac's sound for a screen share.
 *
 * WKWebView's getDisplayMedia never returns audio, so on macOS the shell
 * captures system audio with ScreenCaptureKit (src-tauri/src/sysaudio.rs) and
 * this module pulls the PCM over IPC into an AudioWorklet, whose output is a
 * MediaStreamTrack the engine sends beside the screen video. Chromium builds
 * (Windows, browser guests) get the audio from the picker itself and never
 * come here.
 */

import { invoke } from "@tauri-apps/api/core";
import workletUrl from "./system-audio-worklet.ts?worker&url";

/** A live system-audio track and the handle that ends it. */
export interface SystemAudioCapture {
  track: MediaStreamTrack;
  stop(): void;
}

interface Format {
  /** This capture's id: reads and the stop are bound to it, so a handle the
   *  share discarded cannot touch the capture of the share that followed. */
  id: number;
  sampleRate: number;
  channels: number;
}

/** The shell's answer on a macOS before 13: share without sound. */
const UNSUPPORTED = "unsupported";

/**
 * Start capturing. Resolves null where the OS cannot capture; rejects when it
 * should have and did not. `onError` fires if the capture fails later — the
 * track then carries silence, and the caller tells the user.
 */
export async function captureSystemAudio(onError: (err: unknown) => void): Promise<SystemAudioCapture | null> {
  let format: Format;
  try {
    format = await invoke<Format>("system_audio_start");
  } catch (err) {
    if (err === UNSUPPORTED) return null;
    throw err;
  }

  // Its own context at the capture's rate: nothing to resample, and the
  // engine's playback context (and its output device) is left alone.
  const ctx = new AudioContext({ sampleRate: format.sampleRate });
  let node: AudioWorkletNode;
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(ctx, "system-audio-source", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [format.channels],
    });
  } catch (err) {
    void ctx.close();
    void invoke("system_audio_stop", { id: format.id });
    throw err;
  }
  node.port.postMessage({ channels: format.channels });
  const destination = ctx.createMediaStreamDestination();
  node.connect(destination);
  if (ctx.state === "suspended") void ctx.resume();

  let running = true;
  const stop = () => {
    if (!running) return;
    running = false;
    node.disconnect();
    void ctx.close();
    void invoke("system_audio_stop", { id: format.id });
  };

  // Pull loop: each read answers with whatever PCM is queued (or nothing
  // after a short wait), and the worklet plays it as it lands.
  void (async () => {
    try {
      while (running) {
        const pcm = await invoke<ArrayBuffer>("system_audio_read", { id: format.id });
        if (!running) break;
        if (pcm.byteLength > 0) node.port.postMessage(pcm, [pcm]);
      }
    } catch (err) {
      if (!running) return;
      stop();
      onError(err);
    }
  })();

  return { track: destination.stream.getAudioTracks()[0], stop };
}
