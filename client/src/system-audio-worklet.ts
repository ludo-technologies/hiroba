/**
 * system-audio-worklet.ts — AudioWorklet that plays PCM pushed from the shell.
 *
 * sysaudio.ts posts ArrayBuffers of interleaved f32 frames (the format the
 * Rust capture reports); this processor queues them and renders them as the
 * node's output, which feeds a MediaStreamAudioDestinationNode and so becomes
 * the screen share's audio track. Runs in the AudioWorkletGlobalScope — no
 * DOM, no imports.
 */

// The worklet scope's globals are not in lib.dom.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

/** Playback starts once this much is queued, so a jittery pipe does not
 *  stutter on the first frames. */
const PRIME_SECONDS = 0.04;
/** More than this queued means the pipe fell behind; the oldest is dropped so
 *  the delay never grows past it. */
const MAX_QUEUED_SECONDS = 0.3;

class SystemAudioSource extends AudioWorkletProcessor {
  private chunks: Float32Array[] = [];
  /** Read position within chunks[0], in samples. */
  private offset = 0;
  /** Interleaved samples queued across all chunks. */
  private queued = 0;
  private primed = false;
  private channels = 2;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ArrayBuffer | { channels: number }>) => {
      if (!(ev.data instanceof ArrayBuffer)) {
        this.channels = ev.data.channels;
        return;
      }
      const chunk = new Float32Array(ev.data);
      this.chunks.push(chunk);
      this.queued += chunk.length;
      const max = MAX_QUEUED_SECONDS * sampleRate * this.channels;
      while (this.queued > max && this.chunks.length > 1) {
        const dropped = this.chunks.shift()!;
        this.queued -= dropped.length - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const frames = out[0]?.length ?? 0;
    const channels = out.length;
    if (!this.primed) {
      if (this.queued < PRIME_SECONDS * sampleRate * this.channels) return true;
      this.primed = true;
    }
    for (let frame = 0; frame < frames; frame++) {
      if (this.chunks.length === 0) {
        // Underrun: silence until the pipe catches up, then re-prime.
        this.primed = false;
        return true;
      }
      const chunk = this.chunks[0];
      for (let c = 0; c < channels; c++) {
        out[c][frame] = chunk[this.offset + Math.min(c, this.channels - 1)];
      }
      this.offset += this.channels;
      this.queued -= this.channels;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("system-audio-source", SystemAudioSource);
