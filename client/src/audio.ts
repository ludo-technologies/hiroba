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
  /** Sender carrying our local screen-share video to this peer, if any. */
  screenSender: RTCRtpSender | null;
  /** Remote screen-share stream from this peer, if currently present. */
  remoteScreenStream: MediaStream | null;
  /** The attached remote screen video track (for dedup on renegotiation). */
  remoteScreenTrack: MediaStreamTrack | null;
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

  /** Preferred input/output device (null = system default). Persisted by ui.ts. */
  private micDeviceId: string | null = null;
  private speakerDeviceId: string | null = null;

  /**
   * Mic-preview stream for the audio-settings panel: lets the user watch the
   * input level meter and try a different device *before* ever unmuting (the
   * real call track is only acquired on first unmute, per FR-08). Unused
   * whenever a live call track already exists — the meter reads that instead.
   */
  private previewStream: MediaStream | null = null;
  private previewSource: MediaStreamAudioSourceNode | null = null;
  private previewAnalyser: AnalyserNode | null = null;

  /** Bumped on every mic-device operation; a stale in-flight getUserMedia call
   *  checks this after awaiting and discards its result if it's out of date
   *  (rapid device switching must not let an earlier call clobber a later one). */
  private micEpoch = 0;

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

  /** Notifies main/UI when a remote peer starts or stops screen sharing. */
  private onRemoteScreen:
    | ((peerId: string, stream: MediaStream | null) => void)
    | null = null;

  /** Notifies main/UI when local screen sharing starts or stops. */
  private onLocalScreen: ((stream: MediaStream | null) => void) | null = null;

  /** Local display stream + video track while screen sharing is active. */
  private screenStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;

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
    onRemoteScreen?: (peerId: string, stream: MediaStream | null) => void,
    onLocalScreen?: (stream: MediaStream | null) => void,
  ): void {
    this.space = space;
    this.sendSignal = sendSignal;
    this.onWake = onWake;
    this.onRemoteScreen = onRemoteScreen ?? null;
    this.onLocalScreen = onLocalScreen ?? null;
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
      // A page link may open on an existing proximity PC; attach screen share
      // now if we are already sharing (page-only — see _addScreenTrack).
      if (kind === "page") this._addScreenTrack(existing);
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

  /** Currently selected input/output device (null = system default). */
  get micDevice(): string | null {
    return this.micDeviceId;
  }
  get speakerDevice(): string | null {
    return this.speakerDeviceId;
  }

  // -------------------------------------------------------------------------
  // Device selection (audio-settings panel)
  // -------------------------------------------------------------------------

  /** List available input/output devices. Labels are blank until the browser
   *  has granted mic permission at least once (FR-08: we don't request it
   *  just to populate this list — a preview or a real unmute grants it). */
  async listDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devices.filter((d) => d.kind === "audioinput"),
      outputs: devices.filter((d) => d.kind === "audiooutput"),
    };
  }

  /**
   * Select an input device. If a call track already exists, swaps it live via
   * `replaceTrack` on every peer (no renegotiation needed). Otherwise, if a
   * mic preview is running, restarts it on the new device so the settings
   * panel's level meter reflects the choice immediately.
   */
  async setMicDevice(deviceId: string | null): Promise<void> {
    const previous = this.micDeviceId;
    this.micDeviceId = deviceId;
    try {
      if (this.micAcquired) await this._reacquireMic();
      // Independent of the call track: if the settings panel has a preview
      // running (i.e. we're muted or never unmuted), restart it on the new
      // device too, so the meter reflects the choice immediately.
      if (this.previewStream) await this.startMicPreview(deviceId);
    } catch (err) {
      this.micDeviceId = previous; // swap failed — don't strand the preference
      throw err;
    }
  }

  /**
   * Select an output device for all remote audio. Every peer's spatial gain
   * feeds the same AudioContext destination (see `_attachRemoteAudioStream`),
   * so retargeting the whole context covers every peer at once. Requires
   * `AudioContext.setSinkId` (Chromium; not yet in WebKit) — a no-op silently
   * falls back to the system default elsewhere.
   */
  async setSpeakerDevice(deviceId: string | null): Promise<void> {
    this.speakerDeviceId = deviceId;
    await this._applySpeakerDevice();
  }

  private async _applySpeakerDevice(): Promise<void> {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId !== "function") return;
    try {
      await ctx.setSinkId(this.speakerDeviceId ?? "");
    } catch (err) {
      console.error("[audio] setSinkId failed:", err);
    }
  }

  /**
   * Start (or restart) a standalone mic-preview stream for the settings
   * panel's level meter. No-op while *live and unmuted* (`getMicLevel` reads
   * the real call level instead) — but while muted, even with a call track
   * already acquired, the call track is disabled and silent, so a separate
   * preview stream is how the user tests a device without unmuting.
   */
  async startMicPreview(deviceId?: string | null): Promise<void> {
    if (this.micAcquired && !this.muted) return;
    this.stopMicPreview();
    const epoch = ++this.micEpoch;
    const id = deviceId !== undefined ? deviceId : this.micDeviceId;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: id ? { deviceId: { exact: id } } : true,
      video: false,
    });
    if (epoch !== this.micEpoch) {
      // Superseded by a newer device switch (or stopMicPreview/destroy) while
      // this getUserMedia call was in flight — discard, don't clobber.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ctx = this._getAudioContext();
    if (ctx.state === "suspended") void ctx.resume(); // opening the panel is a gesture
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    this.previewStream = stream;
    this.previewSource = source;
    this.previewAnalyser = analyser;
  }

  /** Stop the mic-preview stream, if any (call when the settings panel closes). */
  stopMicPreview(): void {
    this.micEpoch++; // invalidate any in-flight startMicPreview/_reacquireMic call
    try {
      this.previewSource?.disconnect();
    } catch { /* already disconnected */ }
    try {
      this.previewAnalyser?.disconnect();
    } catch { /* already disconnected */ }
    this.previewSource = null;
    this.previewAnalyser = null;
    if (this.previewStream) {
      this.previewStream.getTracks().forEach((t) => t.stop());
      this.previewStream = null;
    }
  }

  /** Instantaneous 0..1 input level, for the settings panel's meter — live
   *  call level while unmuted, preview level otherwise, 0 if neither is active. */
  getMicLevel(): number {
    if (this.micAcquired && !this.muted) return this.selfLevelValue;
    if (this.previewAnalyser) return this._rms(this.previewAnalyser);
    return 0;
  }

  /** Whether our local screen-share track is currently being sent. */
  get isScreenSharing(): boolean {
    return !!this.screenTrack;
  }

  /** Local display stream for self-preview while sharing. */
  get screenShareStream(): MediaStream | null {
    return this.screenStream;
  }

  /**
   * Start sharing the user's screen/window to **page** (1:1 call) peers only.
   * The browser picker must be launched from a user gesture, so UI calls this
   * directly from the share button. Adding/removing the video track relies on
   * the same perfect-negotiation path as mic changes.
   */
  async startScreenShare(): Promise<void> {
    if (this.screenTrack) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const [track] = stream.getVideoTracks();
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("no video track from getDisplayMedia");
    }

    this.screenStream = stream;
    this.screenTrack = track;
    track.addEventListener("ended", () => this.stopScreenShare(), { once: true });

    for (const entry of this.peers.values()) {
      if (entry.page) this._addScreenTrack(entry);
    }
    this.onLocalScreen?.(stream);
  }

  /** Stop local screen sharing and renegotiate every live peer connection. */
  stopScreenShare(): void {
    const track = this.screenTrack;
    this.screenTrack = null;

    for (const entry of this.peers.values()) {
      this._removeScreenTrack(entry);
    }

    if (track && track.readyState !== "ended") track.stop();
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => {
        if (t !== track && t.readyState !== "ended") t.stop();
      });
    }
    this.screenStream = null;
    this.onLocalScreen?.(null);
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
    this.stopMicPreview();

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
    this.stopScreenShare();

    if (this.audioCtx && this.audioCtx.state !== "closed") {
      void this.audioCtx.close();
    }
    this.audioCtx = null;

    this.micAcquired = false;
    this.muted = true;
    this.space = null;
    this.sendSignal = null;
    this.onWake = null;
    this.onRemoteScreen = null;
    this.onLocalScreen = null;
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
      screenSender: null,
      remoteScreenStream: null,
      remoteScreenTrack: null,
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

    // Remote audio/video arrives here. We always addTrack WITH a stream, so
    // ev.streams[0] is reliably populated for both mic and screen share.
    pc.addEventListener("track", (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (ev.track.kind === "audio" || !ev.track.kind) {
        this._attachRemoteAudioStream(entry, stream);
      } else if (ev.track.kind === "video" && entry.page) {
        this._attachRemoteScreenStream(entry, stream, ev.track);
      }
    });

    // If we already have a mic track, add it now (kicks off negotiation).
    if (this.localTrack && this.localStream) {
      try {
        pc.addTrack(this.localTrack, this.localStream);
      } catch (err) {
        console.error("[audio] addTrack error:", err);
      }
    }
    if (this.screenTrack && this.screenStream && entry.page) this._addScreenTrack(entry);

    return entry;
  }

  private _addScreenTrack(entry: PeerConn): void {
    if (!entry.page) return;
    if (!this.screenTrack || !this.screenStream || entry.screenSender) return;
    try {
      entry.screenSender = entry.pc.addTrack(this.screenTrack, this.screenStream);
    } catch (err) {
      console.error("[audio] add screen track error:", err);
    }
  }

  private _removeScreenTrack(entry: PeerConn): void {
    if (!entry.screenSender) return;
    try {
      entry.pc.removeTrack(entry.screenSender);
    } catch {
      /* PC may already be closed. */
    }
    entry.screenSender = null;
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

  /** Attach a remote audio MediaStream to a GainNode in the AudioContext. */
  private _attachRemoteAudioStream(entry: PeerConn, stream: MediaStream): void {
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

  /** Surface a remote screen-share video stream to the UI layer. */
  private _attachRemoteScreenStream(
    entry: PeerConn,
    stream: MediaStream,
    track: MediaStreamTrack,
  ): void {
    if (entry.remoteScreenTrack === track) return;
    entry.remoteScreenTrack = track;
    entry.remoteScreenStream = stream;
    this.onRemoteScreen?.(entry.id, stream);
    track.addEventListener(
      "ended",
      () => {
        if (entry.remoteScreenTrack !== track) return;
        entry.remoteScreenTrack = null;
        entry.remoteScreenStream = null;
        this.onRemoteScreen?.(entry.id, null);
      },
      { once: true },
    );
  }

  /** Lazily create the AudioContext (browsers require a user gesture first). */
  private _getAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new AudioContext();
      if (this.speakerDeviceId) void this._applySpeakerDevice();
    }
    return this.audioCtx;
  }

  /** getUserMedia constraints for the currently-selected input device. */
  private _micConstraints(): MediaStreamConstraints {
    return {
      audio: this.micDeviceId ? { deviceId: { exact: this.micDeviceId } } : true,
      video: false,
    };
  }

  /** Wire an analyser onto the local mic stream, for the self speaking ring
   *  and the settings-panel level meter. When muted the track is disabled and
   *  produces silence, so the analyser reads ~0 — exactly what we want. */
  private _tapLocalStream(stream: MediaStream): void {
    try {
      this.localLevelSource?.disconnect();
    } catch { /* already disconnected */ }
    try {
      this.localAnalyser?.disconnect();
    } catch { /* already disconnected */ }
    const ctx = this._getAudioContext();
    const localSource = ctx.createMediaStreamSource(stream);
    const localAnalyser = ctx.createAnalyser();
    localAnalyser.fftSize = 512;
    localAnalyser.smoothingTimeConstant = 0.3;
    localSource.connect(localAnalyser); // analysis only; never to destination
    this.localLevelSource = localSource;
    this.localAnalyser = localAnalyser;
  }

  /** Acquire the local microphone track. Called once on first unmute. */
  private async _acquireMic(): Promise<void> {
    this.micAcquired = true; // set before await to prevent duplicate calls
    try {
      const stream = await navigator.mediaDevices.getUserMedia(this._micConstraints());
      const [track] = stream.getAudioTracks();
      if (!track) {
        this.micAcquired = false;
        throw new Error("no audio track from getUserMedia");
      }
      this.localStream = stream;
      this.localTrack = track;
      track.enabled = !this.muted; // still muted until the toggle completes
      this._tapLocalStream(stream);

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

  /**
   * Swap the live call track for one from a newly-selected input device.
   * Uses `replaceTrack` on each peer's existing sender — no renegotiation, no
   * audible drop. Called from `setMicDevice` while a call track is live.
   */
  private async _reacquireMic(): Promise<void> {
    const oldTrack = this.localTrack;
    const oldStream = this.localStream;
    const epoch = ++this.micEpoch;
    const stream = await navigator.mediaDevices.getUserMedia(this._micConstraints());
    const [track] = stream.getAudioTracks();
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("no audio track from getUserMedia");
    }
    if (epoch !== this.micEpoch) {
      // A newer setMicDevice call (or a preview) superseded this one while
      // getUserMedia was in flight — drop it instead of clobbering the winner.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    track.enabled = !this.muted;

    for (const entry of this.peers.values()) {
      const sender = entry.pc.getSenders().find((s) => s.track === oldTrack);
      try {
        if (sender) await sender.replaceTrack(track);
        else entry.pc.addTrack(track, stream);
      } catch (err) {
        console.error("[audio] replaceTrack error:", err);
      }
    }

    this._tapLocalStream(stream);
    this.localStream = stream;
    this.localTrack = track;
    if (oldTrack) oldTrack.stop();
    if (oldStream) oldStream.getTracks().forEach((t) => { if (t !== oldTrack) t.stop(); });
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
    if (entry.remoteScreenStream) {
      this.onRemoteScreen?.(entry.id, null);
      entry.remoteScreenStream = null;
      entry.remoteScreenTrack = null;
    }
    entry.source = null;
    entry.gainNode = null;
    entry.analyser = null;
    entry.sink = null;
    entry.level = 0;
    entry.screenSender = null;
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
