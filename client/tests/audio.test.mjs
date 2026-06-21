/**
 * Regression tests for AudioEngine's remote-stream attach path (src/audio.ts).
 *
 * Guards two real bugs found by end-to-end testing:
 *  - BUG #2: a remote WebRTC stream produces silence in Web Audio on Chromium
 *    (incl. WebView2) unless an HTMLMediaElement also consumes it. Without the
 *    muted <audio> sink, spatial voice AND the speaking ring read silence.
 *  - BUG #3: when a remote track attaches while the loop is idle, the engine
 *    must wake the loop so it starts metering that peer's voice.
 *
 * The browser APIs are mocked minimally; we drive the public `connect()` path
 * and fire the captured `track` listener, exactly as a real RTCPeerConnection
 * would. Run via `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioEngine } from "../.test-build/audio.js";

// --- Minimal Web API mocks -------------------------------------------------

class FakeNode {
  connect() {}
  disconnect() {}
}
class FakeGain extends FakeNode {
  gain = { value: 0 };
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  getByteTimeDomainData(buf) {
    buf.fill(128); // silence (128 = zero in unsigned time-domain)
  }
}
class FakeAudioContext {
  state = "running";
  destination = {};
  createMediaStreamSource() {
    return new FakeNode();
  }
  createGain() {
    return new FakeGain();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
class FakeAudio {
  constructor() {
    FakeAudio.instances.push(this);
    this.srcObject = null;
    this.muted = false;
    this.autoplay = false;
    this.played = false;
    this.paused = false;
  }
  play() {
    this.played = true;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}
FakeAudio.instances = [];

class FakeMediaStream {
  constructor(tracks = []) {
    this._tracks = tracks;
  }
  getTracks() {
    return this._tracks;
  }
  getAudioTracks() {
    return this._tracks;
  }
}
class FakePC {
  constructor() {
    FakePC.instances.push(this);
    this.signalingState = "stable";
    this.localDescription = null;
    this.closed = false;
    this._listeners = {};
  }
  addEventListener(type, cb) {
    (this._listeners[type] ||= []).push(cb);
  }
  fire(type, ev) {
    for (const cb of this._listeners[type] || []) cb(ev);
  }
  addTrack() {}
  close() {
    this.closed = true;
  }
}
FakePC.instances = [];

// Fake microphone: records the last track handed out so tests can assert the
// unmute path enabled it (the mechanism page barge-in relies on).
const FakeMic = {
  lastTrack: null,
  getUserMedia() {
    const track = { kind: "audio", enabled: false, stop() {} };
    FakeMic.lastTrack = track;
    return Promise.resolve(new FakeMediaStream([track]));
  },
};

function installMocks() {
  globalThis.RTCPeerConnection = FakePC;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.Audio = FakeAudio;
  globalThis.MediaStream = FakeMediaStream;
  // navigator is a read-only built-in in modern Node; override it explicitly.
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: FakeMic.getUserMedia } },
    configurable: true,
    writable: true,
  });
  FakePC.instances = [];
  FakeAudio.instances = [];
  FakeMic.lastTrack = null;
}

const SPACE = {
  id: "lobby", name: "Lobby", kind: "lobby",
  width: 1600, height: 1000, nearRadius: 300, farRadius: 360, tickHz: 12, capacity: 32,
};

// --- Tests -----------------------------------------------------------------

test("BUG #2 + #3: attaching a remote track makes a muted sink and wakes the loop", async () => {
  installMocks();
  let wakes = 0;
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => { wakes++; });

  await eng.connect("3", true); // creates the (mock) RTCPeerConnection
  const pc = FakePC.instances.at(-1);
  assert.ok(pc, "a peer connection was created");

  const stream = new FakeMediaStream([{ kind: "audio" }]);
  pc.fire("track", { streams: [stream], track: { kind: "audio" } });

  // BUG #2: a muted <audio> sink consumes the remote stream so Chromium pumps
  // it into Web Audio. Output still flows via the gain node, so the sink stays
  // muted to avoid bypassing spatial attenuation.
  assert.equal(FakeAudio.instances.length, 1, "exactly one media-element sink was created");
  const sink = FakeAudio.instances[0];
  assert.equal(sink.srcObject, stream, "sink consumes the remote stream");
  assert.equal(sink.muted, true, "sink is muted (output goes through the gain node)");
  assert.equal(sink.played, true, "sink.play() was called to pull the track");

  // BUG #3: the loop is woken so it begins metering this peer's voice.
  assert.ok(wakes >= 1, "the render loop was woken on track attach");
});

test("the speaking-ring tap exists and the peer reports zero level while silent", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("5", true);
  FakePC.instances.at(-1).fire("track", { streams: [new FakeMediaStream([{}])], track: {} });

  // The analyser returns silence (128s) → smoothed level stays 0.
  eng.pollLevels();
  assert.equal(eng.getLevel("5"), 0, "a silent peer reports level 0");
});

test("disconnect tears down the sink (pause + release the stream)", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("7", true);
  FakePC.instances.at(-1).fire("track", { streams: [new FakeMediaStream([{}])], track: {} });
  const sink = FakeAudio.instances[0];

  eng.disconnect("7");
  assert.equal(sink.paused, true, "sink was paused");
  assert.equal(sink.srcObject, null, "sink released the stream (no leak)");
  assert.equal(FakePC.instances.at(-1).closed, true, "the peer connection was closed");
});

// Helper: attach a remote stream to the most recently created peer connection.
function attachTrack() {
  FakePC.instances.at(-1).fire("track", { streams: [new FakeMediaStream([{}])], track: {} });
  return FakeAudio.instances.at(-1);
}
function gainOf(eng, id) {
  // The gain node is internal; reach it via the same map updateGains uses.
  return eng.peers?.get?.(id)?.gainNode?.gain?.value;
}

test("page link is full-gain and mutes space (proximity) audio while live", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  // A proximity peer at the origin (close to self → would be loud).
  await eng.connect("3", true, "proximity");
  attachTrack();
  // A page peer (cross-space, no position).
  await eng.connect("9", true, "page");
  attachTrack();

  assert.equal(eng.hasPage(), true, "engine reports an active page link");

  const self = { x: 0, y: 0 };
  const positions = new Map([["3", { x: 0, y: 0 }]]); // peer 3 right on top of us
  eng.updateGains(self, positions);

  // Page peer: always full gain. Proximity peer: muted while paging.
  assert.equal(gainOf(eng, "9"), 1, "page link plays at full gain");
  assert.equal(gainOf(eng, "3"), 0, "space (proximity) audio is muted during a page");

  // End the page → proximity audio comes back (full, since peer is on top of us).
  eng.endPage("9");
  assert.equal(eng.hasPage(), false, "no page link after hang-up");
  eng.updateGains(self, positions);
  assert.equal(gainOf(eng, "3"), 1, "space audio restored after the page ends");
});

test("paging a near peer then hanging up falls back to proximity (no silence)", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  // Peer 3 is a near proximity peer; we then page the SAME peer.
  await eng.connect("3", true, "proximity");
  attachTrack();
  await eng.connect("3", true, "page"); // upgrade: now both memberships
  assert.equal(eng.peers.get("3")?.page, true, "peer is now a page link");
  assert.equal(eng.peers.get("3")?.proximity, true, "…and still a proximity link");

  // Hang up the page: the PC must survive and revert to spatial audio.
  eng.endPage("3");
  assert.equal(eng.peers.has("3"), true, "PC kept after page ends (still a near peer)");
  assert.equal(eng.peers.get("3")?.page, false, "page membership cleared");
  assert.equal(eng.hasPage(), false, "no page links remain");

  const self = { x: 0, y: 0 };
  eng.updateGains(self, new Map([["3", { x: 0, y: 0 }]]));
  assert.equal(gainOf(eng, "3"), 1, "proximity audio resumes (not silent) after hang-up");

  // And dropping proximity now actually closes it.
  eng.disconnectProximity("3");
  assert.equal(eng.peers.has("3"), false, "peer closed once neither link remains");
});

test("space switch tears down proximity links but keeps page links", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  await eng.connect("3", true, "proximity");
  await eng.connect("4", true, "proximity");
  await eng.connect("9", true, "page");

  eng.disconnectAllProximity();

  assert.equal(eng.peers.has("3"), false, "proximity peer 3 was dropped on space switch");
  assert.equal(eng.peers.has("4"), false, "proximity peer 4 was dropped on space switch");
  assert.equal(eng.peers.has("9"), true, "the page link survived the space switch");
  assert.equal(eng.hasPage(), true, "page link is still active after switching spaces");
});

test("a signal-created peer keeps proximity audio after a page is added and ended", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  // Simulate an offer arriving first → peer created passively as proximity.
  await eng.handleSignal("9", { kind: "candidate", candidate: { candidate: "x", sdpMid: "0", sdpMLineIndex: 0 } });
  assert.equal(eng.peers.get("9")?.proximity, true, "passive peer is a proximity link");
  assert.equal(eng.peers.get("9")?.page, false, "…and not yet a page link");

  // page_connect adds the page membership without dropping proximity.
  await eng.connect("9", true, "page");
  assert.equal(eng.peers.get("9")?.page, true, "connect(page) adds the page membership");
  assert.equal(eng.peers.get("9")?.proximity, true, "proximity membership is preserved");

  // Ending the page must NOT silence the still-present proximity link.
  eng.endPage("9");
  assert.equal(eng.peers.has("9"), true, "peer survives page end (still proximity)");
  assert.equal(eng.peers.get("9")?.proximity, true, "proximity membership remains");
});

test("toggleMute acquires the mic and enables the track (the barge-in path)", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  assert.equal(eng.isMuted, true, "starts muted (FR-12)");

  const muted = await eng.toggleMute();
  assert.equal(muted, false, "first toggle goes live");
  assert.equal(FakeMic.lastTrack?.enabled, true, "the acquired mic track is enabled (voice is live)");
});
