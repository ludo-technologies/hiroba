/**
 * audio.ts — Spatial voice engine for Hiroba.
 *
 * Architecture:
 *  - One RTCPeerConnection per proximity-connected peer.
 *  - Negotiation uses the standard "perfect negotiation" pattern (MDN). The
 *    server's `initiator` flag (numerically smaller id) maps to the *impolite*
 *    peer; the other side is *polite*. Either side may begin negotiation
 *    (e.g. when it unmutes and adds a track) — collisions are resolved by the
 *    polite/impolite roles, so there is no glare even though we renegotiate
 *    lazily on first unmute. Trickle ICE flows over the `signal` relay.
 *  - Remote ICE candidates that arrive before the remote description is set are
 *    buffered and flushed afterwards (candidates-before-SRD is a real ordering
 *    case over a relayed signaling channel).
 *  - Each remote stream feeds a GainNode. Gain is updated every rAF frame by
 *    main.ts calling `updateGains(selfPos, peerPositions)` — this is the actual
 *    "spatial" part: gain = clamp(1 - d/nearRadius, 0, 1).
 *  - FR-08: initial state is MUTED. getUserMedia is deferred until the first
 *    unmute (privacy: we don't grab the mic until the user asks to talk). The
 *    local track is disabled (not removed) while muted so toggling is instant.
 *  - On peer disconnect / leave we close the connection AND disconnect the Web
 *    Audio nodes so the audio graph doesn't leak.
 */

import type { SignalData, SpaceDescriptor } from "./protocol.js";

/**
 * Fallback ICE servers if `init()` is called without an explicit list (e.g.
 * unit tests). The real client resolves these from config.ts so a hosted build
 * can inject TURN (NFR-07); see config.getIceServers().
 */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * Two kinds of audio link share the same WebRTC plumbing (PROTOCOL.md):
 *  - "proximity" — in-space, spatialised (gain falls off with distance), and
 *    torn down on space switch.
 *  - "page"      — cross-space 1:1 barge-in, always full-gain, and kept across
 *    space switches. While any page link is live the space audio is fully
 *    muted (product decision: page takes over, restored on hang-up).
 *
 * A single peer can hold BOTH at once (you page someone you're already near).
 * We therefore track the two memberships independently on one connection and
 * only close the underlying PC when *neither* remains — so hanging up a page
 * with a near peer falls back to proximity audio instead of going silent.
 */
export type LinkKind = "proximity" | "page";

// ---------------------------------------------------------------------------
// Internal per-peer state
// ---------------------------------------------------------------------------

interface PeerConn {
  id: string;
  pc: RTCPeerConnection;
  /** This peer is a proximity (in-space, spatialised) link. */
  proximity: boolean;
  /** This peer is a page (cross-space, full-gain) link. */
  page: boolean;
  /** Polite peer yields on offer collision. Impolite (server initiator) wins. */
  polite: boolean;
  // --- perfect-negotiation bookkeeping ---
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Candidates received before remoteDescription is set; flushed after. */
  pendingCandidates: RTCIceCandidateInit[];
  // --- Web Audio nodes for the remote stream (null until `track` fires) ---
  source: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  /** Voice-activity tap on the raw (pre-gain) remote stream. */
  analyser: AnalyserNode | null;
  /**
   * Muted <audio> sink for the remote stream. On Chromium (incl. WebView2),
   * a MediaStreamAudioSourceNode created from a *remote* WebRTC stream stays
   * silent unless an HTMLMediaElement is also consuming that stream — so
   * without this, both spatial audio AND the speaking ring read silence. The
   * element is muted; actual sound still flows through the gain node.
   */
  sink: HTMLAudioElement | null;
  /** Smoothed 0..1 speech level, updated by pollLevels(). */
  level: number;
}

/**
 * Smoothing for voice-activity meters. Attack is fast (rings appear promptly
 * when someone starts talking); release is slow (rings fade gently rather than
 * flicker on every speech gap), which also keeps the demand-driven render loop
 * awake for a beat after speech so the fade-out is actually drawn.
 */
const LEVEL_ATTACK = 0.6;
const LEVEL_RELEASE = 0.12;
/** Smoothed levels below this read as silence (ring hidden; loop may sleep). */
const ACTIVITY_FLOOR = 0.02;

// ---------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------

export class AudioEngine {
  private space: SpaceDescriptor | null = null;

  /** Local mic stream + its audio track (null until getUserMedia resolves). */
  private localStream: MediaStream | null = null;
  private localTrack: MediaStreamTrack | null = null;

  /** Whether getUserMedia has been attempted (so we only acquire once). */
  private micAcquired = false;

  /** Current mute state. Starts true per FR-08. */
  private muted = true;

  /** AudioContext, created lazily when the first remote stream arrives. */
  private audioCtx: AudioContext | null = null;

  /** Active peer connections keyed by peer id. */
  private peers = new Map<string, PeerConn>();

  /** Voice-activity tap on our own mic (created on first unmute). */
  private localAnalyser: AnalyserNode | null = null;
  private localLevelSource: MediaStreamAudioSourceNode | null = null;
  /** Smoothed 0..1 level of our own voice (0 while muted). */
  private selfLevelValue = 0;

  /** Reused scratch buffer for time-domain analysis (avoids per-frame alloc). */
  private sampleBuf = new Uint8Array(0);

  /** Callback to send a `signal` message to the server (set via init()). */
  private sendSignal: ((to: string, data: SignalData) => void) | null = null;

  /** Wakes the render loop when remote audio becomes available to poll. */
  private onWake: (() => void) | null = null;

  /**
   * ICE servers used for every RTCPeerConnection. Resolved from config.ts by
   * main.ts (STUN for self-host, STUN+TURN for hosted, NFR-07). Defaults to
   * public STUN so tests and any caller that omits it still work.
   */
  private iceServers: RTCIceServer[] = STUN_SERVERS;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Call after receiving `welcome`. `iceServers` is optional: when omitted the
   * engine uses public STUN (the self-host default); main.ts passes the
   * config-resolved list so a hosted build can include TURN (NFR-07 / §7.4).
   */
  init(
    space: SpaceDescriptor,
    sendSignal: (to: string, data: SignalData) => void,
    onWake: () => void,
    iceServers?: RTCIceServer[],
  ): void {
    this.space = space;
    this.sendSignal = sendSignal;
    this.onWake = onWake;
    if (iceServers && iceServers.length > 0) this.iceServers = iceServers;
  }

  /**
   * Swap in a new space's config after `enter_space`. Proximity links from the
   * old space have already been torn down by `disconnectAllProximity`; this
   * just updates the radii used for spatial gain in the new space.
   */
  setSpace(space: SpaceDescriptor): void {
    this.space = space;
  }

  // -------------------------------------------------------------------------
  // Proximity events (from main.ts handling `proximity` server messages)
  // -------------------------------------------------------------------------

  /**
   * Open (or extend) a P2P link to a peer. `initiator` (server tie-break:
   * smaller numeric id) → we are the impolite peer. If a local track already
   * exists it is added immediately, kicking off negotiation.
   *
   * Idempotent and additive: if the peer already exists (e.g. a `signal`
   * arrived first and created it passively, or it is already a proximity peer)
   * we simply turn on the requested membership. The PC is shared.
   */
  async connect(peerId: string, initiator: boolean, kind: LinkKind = "proximity"): Promise<void> {
    const existing = this.peers.get(peerId);
    if (existing) {
      if (kind === "page") existing.page = true;
      else existing.proximity = true;
      return;
    }
    // initiator == impolite, so polite = !initiator
    this._ensurePeer(peerId, /* polite */ !initiator, kind);
    // No manual offer here: adding the track (now or on unmute) triggers
    // onnegotiationneeded, which drives the offer through perfect negotiation.
  }

  /** Hard-close and forget a peer regardless of membership (used on teardown). */
  disconnect(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this._closePeer(entry);
    this.peers.delete(peerId);
  }

  /**
   * Drop a peer's proximity membership (from `proximity.disconnect` /
   * `space_left`). If a page link to the same peer remains, the PC is kept so
   * the call continues; otherwise it is closed.
   */
  disconnectProximity(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.proximity = false;
    if (!entry.page) {
      this._closePeer(entry);
      this.peers.delete(peerId);
    }
  }

  /**
   * Drop a peer's page membership (from `page_end` / hang-up). If the peer is
   * still a proximity peer (you paged someone you were near), the PC is kept
   * and spatial audio resumes; otherwise it is closed.
   */
  endPage(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.page = false;
    if (!entry.proximity) {
      this._closePeer(entry);
      this.peers.delete(peerId);
    }
  }

  /**
   * Drop all proximity memberships, keeping page links intact. Called on
   * `enter_space`: the old space's spatial audio ends, but a cross-space page
   * link survives the move (PROTOCOL.md §"enter_space").
   */
  disconnectAllProximity(): void {
    for (const [id, entry] of this.peers) {
      entry.proximity = false;
      if (!entry.page) {
        this._closePeer(entry);
        this.peers.delete(id);
      }
    }
  }

  /** Whether any page (cross-space 1:1) link is currently live. */
  hasPage(): boolean {
    for (const entry of this.peers.values()) {
      if (entry.page) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Signaling relay (from main.ts handling `signal` server messages)
  // -------------------------------------------------------------------------

  /** Process a relayed WebRTC signal from a remote peer (perfect negotiation). */
  async handleSignal(fromId: string, data: SignalData): Promise<void> {
    // An offer may arrive before our own `proximity.connect` (signaling and
    // proximity are independent server events). Create the peer passively as
    // the polite side — the remote that offered is, by the tie-break, impolite.
    const entry = this.peers.get(fromId) ?? this._ensurePeer(fromId, /* polite */ true, "proximity");
    const { pc } = entry;

    try {
      if (data.kind === "offer" || data.kind === "answer") {
        const description: RTCSessionDescriptionInit = { type: data.kind, sdp: data.sdp };
        const offerCollision =
          data.kind === "offer" &&
          (entry.makingOffer || pc.signalingState !== "stable");

        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) return; // impolite peer ignores colliding offers

        await pc.setRemoteDescription(description); // implicit rollback if polite
        await this._flushCandidates(entry);

        if (data.kind === "offer") {
          await pc.setLocalDescription(); // implicit answer
          this.sendSignal?.(fromId, { kind: "answer", sdp: pc.localDescription!.sdp });
        }
      } else if (data.kind === "candidate") {
        if (pc.remoteDescription) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (err) {
            if (!entry.ignoreOffer) throw err; // suppress only expected races
          }
        } else {
          // Remote description not set yet — buffer and flush later.
          entry.pendingCandidates.push(data.candidate);
        }
      }
    } catch (err) {
      console.error("[audio] handleSignal error:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Gain update (called every rAF frame from main.ts)
  // -------------------------------------------------------------------------

  /**
   * Update gain for every connected peer.
   *  - page links     → full gain (1.0), no spatialisation.
   *  - proximity links → spatial gain = clamp(1 - d/nearRadius, 0, 1).
   *
   * While any page link is live the space audio is fully muted (product
   * decision): page takes over the ears, and proximity gain is restored when
   * the page ends.
   */
  updateGains(
    selfPos: { x: number; y: number },
    peerPositions: ReadonlyMap<string, { x: number; y: number }>,
  ): void {
    if (!this.space) return;
    const { nearRadius } = this.space;
    const paging = this.hasPage();

    for (const [id, entry] of this.peers) {
      if (!entry.gainNode) continue;
      if (entry.page) {
        entry.gainNode.gain.value = 1; // 1:1 barge-in, always full-gain
        continue;
      }
      // Proximity link: muted entirely while a page is in progress.
      if (paging) {
        entry.gainNode.gain.value = 0;
        continue;
      }
      const pos = peerPositions.get(id);
      if (!pos) {
        entry.gainNode.gain.value = 0;
        continue;
      }
      const dx = selfPos.x - pos.x;
      const dy = selfPos.y - pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      entry.gainNode.gain.value = Math.max(0, Math.min(1, 1 - d / nearRadius));
    }
  }

  // -------------------------------------------------------------------------
  // Voice-activity metering (drives speaking rings + keeps the loop awake)
  // -------------------------------------------------------------------------

  /**
   * Sample every analyser once and update the smoothed per-peer + self levels.
   * Called once per frame by the main loop. Returns `true` if anyone (peers or
   * self) is currently above the silence floor — the loop uses this to decide
   * whether it must keep animating or may go idle.
   */
  pollLevels(): boolean {
    let active = false;

    for (const entry of this.peers.values()) {
      const raw = entry.analyser ? this._rms(entry.analyser) : 0;
      entry.level = smoothLevel(entry.level, raw);
      if (entry.level > ACTIVITY_FLOOR) active = true;
    }

    // Self level is only meaningful while live (unmuted): a disabled track
    // reads as silence anyway, but short-circuiting avoids the FFT read.
    const rawSelf = this.localAnalyser && !this.muted ? this._rms(this.localAnalyser) : 0;
    this.selfLevelValue = smoothLevel(this.selfLevelValue, rawSelf);
    if (this.selfLevelValue > ACTIVITY_FLOOR) active = true;

    return active;
  }

  /** Smoothed 0..1 speaking level for a peer (0 if unknown). */
  getLevel(id: string): number {
    const v = this.peers.get(id)?.level ?? 0;
    return v > ACTIVITY_FLOOR ? v : 0;
  }

  /** Smoothed 0..1 speaking level for self (0 while muted). */
  get selfLevel(): number {
    return this.selfLevelValue > ACTIVITY_FLOOR ? this.selfLevelValue : 0;
  }

  /** Root-mean-square of an analyser's time-domain frame, normalized to ~0..1. */
  private _rms(analyser: AnalyserNode): number {
    const n = analyser.fftSize;
    if (this.sampleBuf.length !== n) this.sampleBuf = new Uint8Array(n);
    const buf = this.sampleBuf;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = (buf[i] - 128) / 128; // -1..1
      sum += v * v;
    }
    const rms = Math.sqrt(sum / n);
    // Speech RMS rarely exceeds ~0.3; scale so normal talking lands near 1.
    return Math.min(1, rms * 3.3);
  }

  // -------------------------------------------------------------------------
  // Mute toggle (called from ui.ts)
  // -------------------------------------------------------------------------

  /**
   * Toggle mute. First unmute lazily acquires the mic and adds the track to all
   * peers (which triggers renegotiation via onnegotiationneeded).
   * Returns the new muted state.
   */
  async toggleMute(): Promise<boolean> {
    this.muted = !this.muted;

    // The mic toggle is a user gesture — a good moment to resume an
    // AudioContext that a browser autoplay policy may have left suspended
    // (it can be created earlier, when the first remote stream arrives, with
    // no gesture). Without this, remote audio can stay silent.
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      void this.audioCtx.resume();
    }

    if (!this.muted && !this.micAcquired) {
      try {
        await this._acquireMic();
      } catch {
        // Mic acquisition failed (denied/no device): revert to muted.
        this.muted = true;
        return this.muted;
      }
    }

    if (this.localTrack) {
      this.localTrack.enabled = !this.muted;
    }
    return this.muted;
  }

  /** Current mute state (for initializing the UI without toggling). */
  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Whether any P2P audio connection currently exists (i.e. someone is within
   * talking range). The loop uses this to keep a cheap voice poll alive while
   * clustered, and to sleep fully when alone or everyone is out of range — a
   * silent, connectionless plaza costs nothing.
   */
  hasConnections(): boolean {
    return this.peers.size > 0;
  }

  // -------------------------------------------------------------------------
  // Full teardown (on leave)
  // -------------------------------------------------------------------------

  destroy(): void {
    for (const entry of this.peers.values()) this._closePeer(entry);
    this.peers.clear();

    try {
      this.localLevelSource?.disconnect();
    } catch { /* already disconnected */ }
    try {
      this.localAnalyser?.disconnect();
    } catch { /* already disconnected */ }
    this.localLevelSource = null;
    this.localAnalyser = null;
    this.selfLevelValue = 0;

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.localTrack = null;

    if (this.audioCtx && this.audioCtx.state !== "closed") {
      void this.audioCtx.close();
    }
    this.audioCtx = null;

    this.micAcquired = false;
    this.muted = true;
    this.space = null;
    this.sendSignal = null;
    this.onWake = null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Create (or return existing) peer connection with all handlers wired. */
  private _ensurePeer(peerId: string, polite: boolean, kind: LinkKind): PeerConn {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry: PeerConn = {
      id: peerId,
      pc,
      proximity: kind === "proximity",
      page: kind === "page",
      polite,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      source: null,
      gainNode: null,
      analyser: null,
      sink: null,
      level: 0,
    };
    this.peers.set(peerId, entry);

    // Trickle our local ICE candidates to the peer.
    pc.addEventListener("icecandidate", (ev) => {
      if (!ev.candidate) return; // null = end-of-candidates
      this.sendSignal?.(peerId, {
        kind: "candidate",
        candidate: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        },
      });
    });

    // Perfect-negotiation: whenever (re)negotiation is needed, make an offer.
    pc.addEventListener("negotiationneeded", () => {
      void (async () => {
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription(); // implicit createOffer
          this.sendSignal?.(peerId, { kind: "offer", sdp: pc.localDescription!.sdp });
        } catch (err) {
          console.error("[audio] negotiationneeded error:", err);
        } finally {
          entry.makingOffer = false;
        }
      })();
    });

    // Remote audio arrives here. We always addTrack WITH a stream, so
    // ev.streams[0] is reliably populated.
    pc.addEventListener("track", (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this._attachRemoteStream(entry, stream);
    });

    // If we already have a mic track, add it now (kicks off negotiation).
    if (this.localTrack && this.localStream) {
      try {
        pc.addTrack(this.localTrack, this.localStream);
      } catch (err) {
        console.error("[audio] addTrack error:", err);
      }
    }

    return entry;
  }

  /** Add any buffered ICE candidates now that the remote description is set. */
  private async _flushCandidates(entry: PeerConn): Promise<void> {
    if (entry.pendingCandidates.length === 0) return;
    const pending = entry.pendingCandidates;
    entry.pendingCandidates = [];
    for (const cand of pending) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn("[audio] flush candidate failed:", err);
      }
    }
  }

  /** Attach a remote MediaStream to a GainNode in the AudioContext. */
  private _attachRemoteStream(entry: PeerConn, stream: MediaStream): void {
    // Renegotiation can fire `track` again for an existing connection; only
    // build the audio graph once per peer.
    if (entry.gainNode) return;

    const ctx = this._getAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 0; // start silent; updateGains sets it each frame
    source.connect(gain);
    gain.connect(ctx.destination);

    // Voice-activity tap on the *raw* stream (pre-gain) so the speaking ring
    // reflects whether the peer is actually talking, independent of how far
    // away they are. This is a side branch — an analyser produces no sound, so
    // it never reaches the destination and cannot affect what we hear.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    // Muted media-element sink: forces Chromium to pump the remote track into
    // the Web Audio graph (see PeerConn.sink). Kept muted so we don't bypass
    // the spatial gain; output is via `gain → destination` above.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    sink.autoplay = true;
    void sink.play().catch(() => {
      /* autoplay may reject before a gesture; the gain path still produces
         sound, and a later unmute click resumes everything. */
    });

    entry.source = source;
    entry.gainNode = gain;
    entry.analyser = analyser;
    entry.sink = sink;

    // Remote voice is now flowing and pollable — make sure the render loop is
    // awake to meter it and animate the speaking ring, even if it had gone idle
    // while this peer was silently connecting.
    this.onWake?.();
  }

  /** Lazily create the AudioContext (browsers require a user gesture first). */
  private _getAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new AudioContext();
    }
    return this.audioCtx;
  }

  /** Acquire the local microphone track. Called once on first unmute. */
  private async _acquireMic(): Promise<void> {
    this.micAcquired = true; // set before await to prevent duplicate calls
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const [track] = stream.getAudioTracks();
      if (!track) {
        this.micAcquired = false;
        throw new Error("no audio track from getUserMedia");
      }
      this.localStream = stream;
      this.localTrack = track;
      track.enabled = !this.muted; // still muted until the toggle completes

      // Tap our own mic for the self speaking ring. When muted the track is
      // disabled and produces silence, so the analyser reads ~0 — exactly what
      // we want (no self ring while muted).
      const ctx = this._getAudioContext();
      const localSource = ctx.createMediaStreamSource(stream);
      const localAnalyser = ctx.createAnalyser();
      localAnalyser.fftSize = 512;
      localAnalyser.smoothingTimeConstant = 0.3;
      localSource.connect(localAnalyser); // analysis only; never to destination
      this.localLevelSource = localSource;
      this.localAnalyser = localAnalyser;

      // Add the track (with its stream) to every existing peer. Each addTrack
      // fires onnegotiationneeded, renegotiating to send our audio.
      for (const entry of this.peers.values()) {
        try {
          entry.pc.addTrack(track, stream);
        } catch {
          // PC may have closed in the meantime — ignore.
        }
      }
    } catch (err) {
      this.micAcquired = false;
      console.error("[audio] getUserMedia failed:", err);
      throw err;
    }
  }

  /** Close and clean up a single peer entry, including its Web Audio nodes. */
  private _closePeer(entry: PeerConn): void {
    try {
      entry.source?.disconnect();
    } catch { /* already disconnected */ }
    try {
      entry.gainNode?.disconnect();
    } catch { /* already disconnected */ }
    try {
      entry.analyser?.disconnect();
    } catch { /* already disconnected */ }
    if (entry.sink) {
      try { entry.sink.pause(); } catch { /* ignore */ }
      entry.sink.srcObject = null;
    }
    entry.source = null;
    entry.gainNode = null;
    entry.analyser = null;
    entry.sink = null;
    entry.level = 0;
    try {
      entry.pc.close();
    } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Asymmetric exponential smoothing: rise fast toward a louder reading, fall
 * slowly toward a quieter one. Keeps speaking rings responsive without making
 * them flicker on the natural micro-gaps in speech.
 */
function smoothLevel(prev: number, next: number): number {
  const k = next > prev ? LEVEL_ATTACK : LEVEL_RELEASE;
  return prev + (next - prev) * k;
}
