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
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { AudioEngine, inGroupPlace, spatialGain } from "../.test-build/audio.js";

// --- Minimal Web API mocks -------------------------------------------------

class FakeNode {
  connect() {}
  disconnect() {}
}
class FakeGain extends FakeNode {
  gain = { value: 0 };
  constructor() {
    super();
    FakeGain.instances.push(this);
  }
}
FakeGain.instances = [];
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  getByteTimeDomainData(buf) {
    buf.fill(128); // silence (128 = zero in unsigned time-domain)
  }
}
class FakeOscillator extends FakeNode {
  constructor() {
    super();
    FakeOscillator.instances.push(this);
    this.type = "sine";
    this.frequency = { value: 0 };
    this.started = false;
    this.stopped = false;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
FakeOscillator.instances = [];

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  createMediaStreamSource() {
    return new FakeNode();
  }
  createGain() {
    const g = new FakeGain();
    // Web Audio automations used by the ringtone envelope.
    g.gain.setValueAtTime = () => {};
    g.gain.linearRampToValueAtTime = () => {};
    return g;
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createOscillator() {
    return new FakeOscillator();
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
    this.id = `stream-${++FakeMediaStream.count}`;
  }
  getTracks() {
    return this._tracks;
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === "audio");
  }
  addTrack(track) {
    this._tracks.push(track);
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === "video");
  }
}

FakeMediaStream.count = 0;

/** A video track that records whether anything stopped it. */
function fakeVideoTrack() {
  return {
    kind: "video",
    readyState: "live",
    stopped: false,
    stop() {
      this.stopped = true;
      this.readyState = "ended";
    },
    addEventListener() {},
  };
}

/** An audio track of a screen capture or the host's system-audio pipe. */
function fakeAudioTrack() {
  return { kind: "audio", readyState: "live", stopped: false, stop() { this.stopped = true; this.readyState = "ended"; }, addEventListener() {} };
}

/** getDisplayMedia/getUserMedia that resolves only when the test says so —
 *  stands in for the OS picker or permission prompt sitting open. `withAudio`
 *  is Chromium's picker with "share audio" ticked. */
function deferredCapture(withAudio = false) {
  const track = fakeVideoTrack();
  const audio = withAudio ? fakeAudioTrack() : null;
  const stream = new FakeMediaStream(audio ? [track, audio] : [track]);
  let release;
  const pending = new Promise((resolve) => {
    release = () => resolve(stream);
  });
  return { track, audio, stream, request: () => pending, release };
}

function deferredMicCapture() {
  const track = {
    kind: "audio",
    enabled: false,
    stopped: false,
    stop() { this.stopped = true; },
  };
  const stream = new FakeMediaStream([track]);
  let release;
  const pending = new Promise((resolve) => {
    release = () => resolve(stream);
  });
  return { track, request: () => pending, release };
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
  addTrack(track) {
    (this.added ||= []).push(track);
    // Like the real thing, a sender always comes back, carrying the track.
    const sender = FakePC.makeSender?.() ?? plainSender();
    sender.track = track;
    return sender;
  }
  removeTrack(sender) {
    (this.removed ||= []).push(sender.track);
  }
  getTransceivers() {
    return [];
  }
  close() {
    this.closed = true;
  }
}
FakePC.instances = [];
/** Set by a test that needs addTrack to hand back a particular sender. */
FakePC.makeSender = null;

/** A sender whose replaceTrack lands at once. */
function plainSender() {
  return {
    track: null,
    replaceTrack(track) {
      this.track = track;
      return Promise.resolve();
    },
    getParameters() {
      return { encodings: [{}] };
    },
    setParameters() {
      return Promise.resolve();
    },
  };
}

/** An RTCRtpSender whose replaceTrack resolves only when the test releases it,
 *  logging every call so ordering can be asserted. */
function fakeSender(log) {
  return {
    replaceTrack(track) {
      let release;
      const done = new Promise((resolve) => {
        release = resolve;
      });
      log.push({ op: "replaceTrack", track, release });
      return done;
    },
    getParameters() {
      return { encodings: [{}] };
    },
    setParameters(params) {
      log.push({ op: "setParameters", mode: params.degradationPreference, maxBitrate: params.encodings[0].maxBitrate });
      return Promise.resolve();
    },
  };
}

// Fake microphone: records the last track handed out so tests can assert the
// unmute path enabled it (the mechanism page barge-in relies on).
const FakeMic = {
  lastTrack: null,
  getUserMedia() {
    const track = {
      kind: "audio", enabled: false, stopped: false, stop() { this.stopped = true; },
      addEventListener(type, cb) { if (type === "ended") this.end = cb; },
    };
    FakeMic.lastTrack = track;
    return Promise.resolve(new FakeMediaStream([track]));
  },
};

function installMocks() {
  globalThis.RTCPeerConnection = FakePC;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.Audio = FakeAudio;
  globalThis.MediaStream = FakeMediaStream;
  // The first-frame probe creates a <video>; without requestVideoFrameCallback
  // the engine skips the check, which is what we want in these tests.
  globalThis.document = { createElement: () => ({}) };
  // navigator is a read-only built-in in modern Node; override it explicitly.
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: FakeMic.getUserMedia } },
    configurable: true,
    writable: true,
  });
  FakePC.instances = [];
  FakePC.makeSender = null;
  globalThis.RTCRtpSender = { getCapabilities: () => null };
  FakeAudio.instances = [];
  FakeGain.instances = [];
  FakeOscillator.instances = [];
  FakeMic.lastTrack = null;
}

const SPACE = {
  id: "lobby", name: "Lobby", kind: "lobby",
  width: 1600, height: 1000, nearRadius: 300, farRadius: 360, tickHz: 12, capacity: 32,
};
const TEAM = {
  ...SPACE, id: "dev", name: "Dev", kind: "team", width: 800, height: 600, nearRadius: 1100, farRadius: 1100,
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

// Make a peer's analyser read as loud speech (192 → (192-128)/128 = 0.5 RMS).
function makeLoud(eng, id) {
  eng.peers.get(id).analyser.getByteTimeDomainData = (buf) => buf.fill(192);
}

test("the speaking ring does not show space peers we cannot hear during a page", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  await eng.connect("3", true, "proximity");
  attachTrack();
  makeLoud(eng, "3");

  // No page yet: a talking proximity peer rings, however faint the distance
  // gain would make them. That behaviour must survive this fix.
  eng.pollLevels();
  assert.ok(eng.getLevel("3") > 0, "a talking space peer rings while audible");

  // Page starts → updateGains forces peer 3 to gain 0, so they are inaudible.
  await eng.connect("9", true, "page");
  attachTrack();
  makeLoud(eng, "9");
  eng.updateGains({ x: 0, y: 0 }, new Map([["3", { x: 0, y: 0 }]]));
  assert.equal(gainOf(eng, "3"), 0, "precondition: the space peer is fully muted");

  // The ring fades out rather than popping, so poll until it settles.
  for (let i = 0; i < 100 && eng.getLevel("3") > 0; i++) eng.pollLevels();
  assert.equal(eng.getLevel("3"), 0, "a muted space peer stops ringing (we hear nothing)");
  assert.ok(eng.getLevel("9") > 0, "the page peer we DO hear still rings");

  // Hang up → the space peer is audible again and rings on the next poll.
  eng.endPage("9");
  eng.pollLevels();
  assert.ok(eng.getLevel("3") > 0, "the ring returns once the page ends");
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

test("incoming page ringtone starts dual-tone oscillators and stops cleanly", () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  assert.equal(eng.isRinging, false, "idle engine is not ringing");
  eng.startRingtone();
  assert.equal(eng.isRinging, true, "startRingtone latches the ringing flag");
  assert.equal(FakeOscillator.instances.length, 2, "dual-tone ring uses two oscillators");
  assert.ok(
    FakeOscillator.instances.every((o) => o.started),
    "both oscillators were started",
  );

  // Idempotent: a second offer must not stack another pair of oscillators.
  eng.startRingtone();
  assert.equal(FakeOscillator.instances.length, 2, "startRingtone is idempotent");

  eng.stopRingtone();
  assert.equal(eng.isRinging, false, "stopRingtone clears the flag");
  assert.ok(
    FakeOscillator.instances.every((o) => o.stopped),
    "both oscillators were stopped",
  );

  // Safe to call again while idle.
  eng.stopRingtone();
  assert.equal(eng.isRinging, false);
});

test("destroy stops an in-progress ringtone", () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  eng.startRingtone();
  assert.equal(eng.isRinging, true);

  eng.destroy();
  assert.equal(eng.isRinging, false, "destroy clears ringtone state");
  assert.ok(
    FakeOscillator.instances.every((o) => o.stopped),
    "destroy stops ringtone oscillators",
  );
});

test("an offer from a peer the server never linked us with is dropped, not answered with the mic", async () => {
  installMocks();
  const sent = [];
  const eng = new AudioEngine();
  eng.init(SPACE, (to, data) => sent.push({ to, data }), () => {});
  await eng.toggleMute(); // the mic is live — exactly what an eavesdropper is after
  assert.equal(FakeMic.lastTrack?.enabled, true);

  await eng.handleSignal("9", { kind: "offer", sdp: "FAKE" });
  assert.equal(eng.peers.has("9"), false, "no peer is created for an unsolicited signal");
  assert.equal(FakePC.instances.length, 0, "no RTCPeerConnection, so no track is attached");
  assert.deepEqual(sent, [], "nothing is answered");
  eng.destroy();
});

/** What a peer currently receives from our microphone: the track on its mic
 *  sender (null = the sender is there but silent; undefined = no sender). */
function micTo(eng, id) {
  return eng.peers.get(id)?.audioSender?.track;
}

test("during a call our voice reaches the caller only, and the space again after", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("near", true, "proximity");
  await eng.toggleMute(); // live
  const mic = FakeMic.lastTrack;
  assert.equal(micTo(eng, "near"), mic, "outside a call the space hears us");

  await eng.connect("caller", true, "page");
  await tick();
  assert.equal(micTo(eng, "caller"), mic, "the call hears us");
  assert.equal(micTo(eng, "near"), null, "the peer next to us does not");

  // Someone walking up mid-call is linked, but hears nothing of it either.
  await eng.connect("late", true, "proximity");
  await tick();
  assert.equal(micTo(eng, "late"), null, "a peer arriving during the call does not");
  assert.deepEqual(FakePC.instances.find((pc) => pc === eng.peers.get("late").pc).added, [mic],
    "…though the sender is there, so no renegotiation is needed when the call ends");

  eng.endPage("caller");
  await tick();
  assert.equal(micTo(eng, "near"), mic, "hanging up gives our voice back to the space");
  assert.equal(micTo(eng, "late"), mic);
  eng.destroy();
});

test("unmuting during a call sends the new mic to the call only", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("near", true, "proximity");
  await eng.connect("caller", true, "page");
  await eng.toggleMute(); // the auto-unmute on answering takes this path
  await tick();
  const mic = FakeMic.lastTrack;
  assert.equal(micTo(eng, "caller"), mic);
  assert.equal(micTo(eng, "near"), null, "the space never gets the track");
  eng.destroy();
});

test("switching microphones during a call moves the call over and keeps the space silent", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("near", true, "proximity");
  await eng.toggleMute();
  await eng.connect("caller", true, "page");
  await tick();
  const before = FakeMic.lastTrack;

  await eng.setMicDevice("usb");
  const after = FakeMic.lastTrack;
  assert.notEqual(after, before);
  assert.equal(micTo(eng, "caller"), after, "the call carries the new mic");
  assert.equal(micTo(eng, "near"), null, "the space still hears nothing");
  assert.equal(before.stopped, true, "the old mic is let go");
  eng.destroy();
});

test("a microphone the OS ends under us is taken again, and the peer hears the new one", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("near", true, "proximity");
  await eng.toggleMute();
  await tick();
  const dead = FakeMic.lastTrack;

  dead.end();
  await tick();
  const fresh = FakeMic.lastTrack;
  assert.notEqual(fresh, dead);
  assert.equal(fresh.enabled, true, "still unmuted");
  assert.equal(micTo(eng, "near"), fresh);
  eng.destroy();
});

test("a microphone that ends while muted is taken again on the next unmute", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("near", true, "proximity");
  await eng.toggleMute();
  await eng.toggleMute(); // muted, track kept for the peer
  const dead = FakeMic.lastTrack;

  dead.end();
  await tick();
  assert.equal(FakeMic.lastTrack, dead, "no mic is taken while muted");
  await eng.toggleMute();
  await tick();
  assert.notEqual(FakeMic.lastTrack, dead);
  assert.equal(micTo(eng, "near"), FakeMic.lastTrack);
  eng.destroy();
});

test("paging the peer next to us keeps our voice on that link", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("9", true, "proximity");
  await eng.toggleMute();
  const mic = FakeMic.lastTrack;
  await eng.connect("9", true, "page");
  await tick();
  assert.equal(micTo(eng, "9"), mic, "the shared link is the call");
  eng.destroy();
});

test("a proximity peer keeps proximity audio after a page is added and ended", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  await eng.connect("9", false, "proximity");
  assert.equal(eng.peers.get("9")?.proximity, true, "a proximity link");
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

test("a screen share that lands after the session is destroyed stops itself", async () => {
  installMocks();
  const capture = deferredCapture();
  navigator.mediaDevices.getDisplayMedia = capture.request;

  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  // The picker is open…
  const sharing = eng.startScreenShare();
  // …and the socket drops, tearing the session down while it is still open.
  eng.destroy();
  capture.release();
  await sharing;

  // destroy() could not stop a stream it never saw, so the capture must stop
  // itself — otherwise the OS keeps recording the screen for a dead engine.
  assert.equal(capture.track.stopped, true, "the orphaned capture was stopped");
  assert.equal(eng.isScreenSharing, false, "the destroyed engine did not arm itself");
  assert.equal(eng.screenShareStream, null, "no stream was retained");
});

test("a screen share that lands after hang-up stops itself", async () => {
  installMocks();
  const capture = deferredCapture();
  navigator.mediaDevices.getDisplayMedia = capture.request;

  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  await eng.connect("9", true, "page");

  const sharing = eng.startScreenShare();
  eng.stopScreenShare(); // the call ended while the picker was open
  capture.release();
  await sharing;

  assert.equal(capture.track.stopped, true, "the orphaned capture was stopped");
  assert.equal(eng.isScreenSharing, false, "sharing did not start after hang-up");
});

test("a camera that lands after the session is destroyed stops itself", async () => {
  installMocks();
  const capture = deferredCapture();
  navigator.mediaDevices.getUserMedia = capture.request;

  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  const starting = eng.startCamera();
  eng.destroy();
  capture.release();
  await starting;

  assert.equal(capture.track.stopped, true, "the orphaned camera was stopped");
  assert.equal(eng.isCameraOn, false, "the destroyed engine did not arm itself");
});

test("an uninterrupted screen share still starts normally", async () => {
  installMocks();
  const capture = deferredCapture();
  navigator.mediaDevices.getDisplayMedia = capture.request;

  const local = [];
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {}, undefined, () => {}, (started) => local.push(started));
  eng.updateGains({ x: 100, y: 100 }, new Map()); // standing in the team space

  const sharing = eng.startScreenShare();
  capture.release();
  await sharing;

  assert.equal(capture.track.stopped, false, "the capture is live");
  assert.equal(eng.isScreenSharing, true, "sharing is active");
  assert.equal(eng.screenShareStream, capture.stream, "the stream is the local preview");
  assert.deepEqual(local, [true], "the UI was told sharing started");
});

test('a peer\'s "video stopped" clears their panel instead of freezing the last frame', async () => {
  installMocks();
  const seen = [];
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {}, undefined, (peerId, videos) => seen.push({ peerId, ...videos }));

  // A peer on a version that sends a single video and names no streams.
  await eng.connect("9", true, "page");
  const pc = FakePC.instances.at(-1);
  const track = fakeVideoTrack();
  const stream = new FakeMediaStream([track]);
  pc.fire("track", { streams: [stream], track });
  await eng.handleSignal("9", { kind: "video-mode", mode: "screen" });
  assert.deepEqual(seen.at(-1), { peerId: "9", screen: stream, camera: null }, "panel shows their screen");

  // The peer stops sharing. `removeTrack()` on their side leaves our receiver
  // muted, not ended, so this signal is the only notice we get.
  await eng.handleSignal("9", { kind: "video-mode", mode: null });
  assert.deepEqual(
    seen.at(-1),
    { peerId: "9", screen: null, camera: null },
    "the viewer is told to drop the panel, not to keep a dead stream",
  );

  // Starting again re-shows it even if the transceiver is recycled silently
  // (no second `track` event).
  await eng.handleSignal("9", { kind: "video-mode", mode: "camera" });
  assert.deepEqual(seen.at(-1), { peerId: "9", screen: null, camera: stream }, "restart re-shows the video");
});

test("a peer's screen and camera, on at once, are told apart by their streams", async () => {
  installMocks();
  const seen = [];
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {}, undefined, (peerId, videos) => seen.push({ peerId, ...videos }));
  await eng.connect("9", true, "page");
  const pc = FakePC.instances.at(-1);

  const camera = new FakeMediaStream([fakeVideoTrack()]);
  const screen = new FakeMediaStream([fakeVideoTrack()]);
  // The label can come before the tracks: nothing shows until both are here.
  await eng.handleSignal("9", {
    kind: "video-mode",
    mode: "screen",
    streams: { screen: screen.id, camera: camera.id },
  });
  assert.deepEqual(seen.at(-1), { peerId: "9", screen: null, camera: null });
  pc.fire("track", { streams: [screen], track: screen.getVideoTracks()[0] });
  pc.fire("track", { streams: [camera], track: camera.getVideoTracks()[0] });
  assert.deepEqual(seen.at(-1), { peerId: "9", screen, camera });

  await eng.handleSignal("9", {
    kind: "video-mode",
    mode: "camera",
    streams: { screen: null, camera: camera.id },
  });
  assert.deepEqual(seen.at(-1), { peerId: "9", screen: null, camera }, "the screen stopped, the face stays");
});

test("toggleMute acquires the mic and enables the track (the barge-in path)", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});
  assert.equal(eng.isMuted, true, "starts muted (FR-12)");

  const muted = await eng.toggleMute();
  assert.equal(muted, false, "first toggle goes live");
  assert.equal(FakeMic.lastTrack?.enabled, true, "the acquired mic track is enabled (voice is live)");
  eng.destroy(); // cancels the idle-release timer so the test process can exit
});

test("destroy stops a microphone capture that resolves after teardown", async () => {
  installMocks();
  const capture = deferredMicCapture();
  navigator.mediaDevices.getUserMedia = capture.request;
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  const toggle = eng.toggleMute();
  eng.destroy();
  capture.release();

  assert.equal(await toggle, true, "the destroyed engine remains muted");
  assert.equal(capture.track.stopped, true, "the stale microphone track was stopped");
});

test("superseding microphone acquisition leaves the engine able to retry", async () => {
  installMocks();
  const capture = deferredMicCapture();
  navigator.mediaDevices.getUserMedia = capture.request;
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  const firstToggle = eng.toggleMute();
  eng.stopMicPreview();
  capture.release();

  assert.equal(await firstToggle, true, "a superseded acquisition returns to muted");
  assert.equal(capture.track.stopped, true, "the superseded track was stopped");

  navigator.mediaDevices.getUserMedia = FakeMic.getUserMedia;
  assert.equal(await eng.toggleMute(), false, "the next unmute retries acquisition");
  assert.equal(FakeMic.lastTrack?.enabled, true, "the retry acquires a live track");
  eng.destroy();
});

test("an unmute whose microphone cannot be had rejects with the reason and stays muted", async () => {
  installMocks();
  navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(new DOMException("Requested device not found", "NotFoundError"));
  const eng = new AudioEngine();
  eng.init(SPACE, () => {}, () => {});

  await assert.rejects(eng.toggleMute(), { name: "NotFoundError" });
  assert.equal(eng.isMuted, true, "the engine is muted again");
  eng.destroy();
});

/** Matches MIC_IDLE_RELEASE_MS in src/audio.ts. */
const MIC_IDLE_RELEASE_MS = 20_000;

test("the mic is released once nobody has been around for a while, and comes back with the next peer", async () => {
  installMocks();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const eng = new AudioEngine();
    eng.init(SPACE, () => {}, () => {});
    await eng.connect("a", true);
    await eng.toggleMute();
    const first = FakeMic.lastTrack;
    assert.equal(first.enabled, true);

    eng.disconnect("a");
    mock.timers.tick(MIC_IDLE_RELEASE_MS - 1);
    assert.equal(first.stopped, false, "kept during the grace period");
    mock.timers.tick(1);
    assert.equal(first.stopped, true, "released once the grace period is over");
    assert.equal(eng.isMuted, false, "the user is still logically unmuted");

    await eng.connect("b", true);
    await tick();
    const second = FakeMic.lastTrack;
    assert.notEqual(second, first, "a peer appearing re-acquires the mic");
    assert.equal(second.enabled, true, "and it goes live without another click");
    assert.equal(second.stopped, false);
  } finally {
    mock.timers.reset();
  }
});

test("a peer leaving and coming back inside the grace period keeps the mic", async () => {
  installMocks();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const eng = new AudioEngine();
    eng.init(SPACE, () => {}, () => {});
    await eng.connect("a", true);
    await eng.toggleMute();
    const track = FakeMic.lastTrack;

    eng.disconnect("a");
    mock.timers.tick(MIC_IDLE_RELEASE_MS / 2);
    await eng.connect("a", true);
    mock.timers.tick(MIC_IDLE_RELEASE_MS);
    assert.equal(track.stopped, false, "the pending release was cancelled");
    assert.equal(FakeMic.lastTrack, track, "no re-acquire happened");
  } finally {
    mock.timers.reset();
  }
});

test("muting with nobody around also lets the mic go, and unmuting re-acquires it", async () => {
  installMocks();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const eng = new AudioEngine();
    eng.init(SPACE, () => {}, () => {});
    await eng.toggleMute();
    const first = FakeMic.lastTrack;
    await eng.toggleMute();
    assert.equal(eng.isMuted, true);
    mock.timers.tick(MIC_IDLE_RELEASE_MS);
    assert.equal(first.stopped, true, "released: nobody can hear it and it is muted");

    assert.equal(await eng.toggleMute(), false);
    assert.notEqual(FakeMic.lastTrack, first, "unmuting acquires a fresh track");
    assert.equal(FakeMic.lastTrack.enabled, true);
  } finally {
    mock.timers.reset();
  }
});

/** Let queued microtasks (the sender update chain) run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** An engine in a call with peer "9", recording the signals it sends. */
async function inCall(twoVideos) {
  installMocks();
  const signals = [];
  const eng = new AudioEngine();
  eng.init(SPACE, (to, data) => signals.push(data), () => {});
  await eng.connect("9", true, "page");
  if (twoVideos) await eng.handleSignal("9", { kind: "two-videos" });
  return { eng, pc: FakePC.instances.at(-1), signals };
}

test("a link opens by saying we can show a screen and a camera at once", async () => {
  const { signals } = await inCall(false);
  assert.deepEqual(signals, [{ kind: "two-videos" }]);
});

test("the camera stays on through a screen share, and both reach a peer that shows both", async () => {
  const { eng, pc, signals } = await inCall(true);

  const camera = await startCamera(eng);
  const screen = await shareScreen(eng);
  assert.equal(eng.isCameraOn, true, "starting the share left the camera on");
  assert.equal(eng.isScreenSharing, true);
  assert.equal(camera.track.stopped, false);
  assert.deepEqual(pc.added, [camera.track, screen.track]);
  assert.equal(pc.removed, undefined, "neither was taken away for the other");
  const label = signals.at(-1);
  assert.equal(label.kind, "video-mode");
  assert.equal(label.mode, "screen");
  assert.ok(label.streams.screen && label.streams.camera, "each video is named");
  assert.notEqual(label.streams.screen, label.streams.camera);

  eng.stopScreenShare();
  assert.equal(screen.track.stopped, true);
  assert.equal(eng.isCameraOn, true, "stopping the share left the camera on");
  assert.deepEqual(pc.removed, [screen.track]);
  assert.deepEqual(signals.at(-1), {
    kind: "video-mode",
    mode: "camera",
    streams: { screen: null, camera: label.streams.camera },
  });
});

test("a peer that shows a single video gets the screen, and the camera back once the share stops", async () => {
  const { eng, pc, signals } = await inCall(false);

  const camera = await startCamera(eng);
  assert.deepEqual(pc.added, [camera.track]);
  const screen = await shareScreen(eng);
  assert.deepEqual(pc.added, [camera.track, screen.track]);
  assert.deepEqual(pc.removed, [camera.track], "the screen took the camera's place");
  assert.equal(signals.at(-1).mode, "screen");
  assert.equal(eng.isCameraOn, true, "the camera itself stays on, for our preview and other peers");

  eng.stopScreenShare();
  assert.deepEqual(pc.added, [camera.track, screen.track, camera.track], "the camera is sent again");
  assert.equal(signals.at(-1).mode, "camera");

  // It turns out to show both after all (its hello was late).
  const screen2 = await shareScreen(eng);
  assert.deepEqual(pc.removed, [camera.track, screen.track, camera.track]);
  await eng.handleSignal("9", { kind: "two-videos" });
  assert.deepEqual(pc.added.slice(-2), [screen2.track, camera.track], "the camera joins the screen");
});

// --- spatialGain: the one rule for gain nodes and the nearby nudge ----------


const LOBBY = {
  ...SPACE, width: 800, height: 600, nearRadius: 150, farRadius: 180,
  meetingRoom: { x: 480, y: 36, w: 280, h: 228 },
};

test("spatialGain: distance falloff on the open floor", () => {
  assert.equal(spatialGain(LOBBY, { x: 100, y: 400 }, { x: 100, y: 400 }), 1);
  assert.equal(spatialGain(LOBBY, { x: 100, y: 400 }, { x: 175, y: 400 }), 0.5);
  assert.equal(spatialGain(LOBBY, { x: 100, y: 400 }, { x: 300, y: 400 }), 0);
});

test("spatialGain: the meeting room is full volume inside and soundproof across", () => {
  // Opposite corners of the room: ~330 apart, well past nearRadius.
  assert.equal(spatialGain(LOBBY, { x: 490, y: 50 }, { x: 750, y: 250 }), 1);
  // 20 apart through the wall, in either direction.
  assert.equal(spatialGain(LOBBY, { x: 490, y: 50 }, { x: 470, y: 50 }), 0);
  assert.equal(spatialGain(LOBBY, { x: 470, y: 50 }, { x: 490, y: 50 }), 0);
  // No room (a team space): plain distance.
  assert.equal(spatialGain(SPACE, { x: 490, y: 50 }, { x: 470, y: 50 }), 1 - 20 / 300);
});

// --- Screen share in a group place (a team space, or the meeting room) ------

const IN_ROOM = { x: 600, y: 100 };
const OUT_OF_ROOM = { x: 300, y: 400 };

/** Connect peers and return each one's PC by id. */
async function connectAll(eng, ids, kind = "proximity") {
  const pcs = {};
  for (const id of ids) {
    await eng.connect(id, true, kind);
    pcs[id] = FakePC.instances.at(-1);
  }
  return pcs;
}

/** Start a screen share whose picker returns straight away; `withAudio` with
 *  the picker's "share audio" ticked. */
async function shareScreen(eng, withAudio = false) {
  const capture = deferredCapture(withAudio);
  navigator.mediaDevices.getDisplayMedia = capture.request;
  const sharing = eng.startScreenShare();
  capture.release();
  await sharing;
  return capture;
}

test("inGroupPlace: anywhere in a team space, only inside the lobby's meeting room", () => {
  assert.equal(inGroupPlace(TEAM, { x: 10, y: 10 }), true);
  assert.equal(inGroupPlace(LOBBY, IN_ROOM), true);
  assert.equal(inGroupPlace(LOBBY, OUT_OF_ROOM), false);
});

test("a screen share in the meeting room reaches the people inside, not the floor outside", async () => {
  installMocks();
  FakePC.makeSender = () => fakeSender([]);
  const eng = new AudioEngine();
  eng.init(LOBBY, () => {}, () => {});
  const pcs = await connectAll(eng, ["in", "out"]);
  eng.updateGains(IN_ROOM, new Map([["in", { x: 700, y: 200 }], ["out", { x: 470, y: 100 }]]));

  const capture = await shareScreen(eng);
  assert.equal(eng.isScreenSharing, true);
  assert.ok(pcs.in.added?.includes(capture.track), "the peer in the room gets the screen");
  assert.ok(!pcs.out.added?.includes(capture.track), "the peer through the wall does not");
});

test("walking out of the meeting room ends the share", async () => {
  installMocks();
  FakePC.makeSender = () => fakeSender([]);
  const eng = new AudioEngine();
  eng.init(LOBBY, () => {}, () => {});
  const positions = new Map([["in", { x: 700, y: 200 }]]);
  await connectAll(eng, ["in"]);
  eng.updateGains(IN_ROOM, positions);
  const capture = await shareScreen(eng);

  eng.updateGains(OUT_OF_ROOM, positions);
  assert.equal(eng.isScreenSharing, false, "the share ended at the door");
  assert.equal(capture.track.stopped, true, "the capture was released");
});

test("walking out of the meeting room with the picker still open cancels the share", async () => {
  installMocks();
  const capture = deferredCapture();
  navigator.mediaDevices.getDisplayMedia = capture.request;
  const eng = new AudioEngine();
  eng.init(LOBBY, () => {}, () => {});
  eng.updateGains(IN_ROOM, new Map());

  const sharing = eng.startScreenShare();
  eng.updateGains(OUT_OF_ROOM, new Map());
  capture.release();
  await sharing;

  assert.equal(capture.track.stopped, true, "the late capture stopped itself");
  assert.equal(eng.isScreenSharing, false);
});

test("a screen share from the open floor, outside any place, does not start", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(LOBBY, () => {}, () => {});
  eng.updateGains(OUT_OF_ROOM, new Map());

  const capture = await shareScreen(eng);
  assert.equal(eng.isScreenSharing, false);
  assert.equal(capture.track.stopped, true);
});

test("a call taking over ends a share meant for the room", async () => {
  installMocks();
  FakePC.makeSender = () => fakeSender([]);
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {});
  const pcs = await connectAll(eng, ["mate"]);
  eng.updateGains({ x: 100, y: 100 }, new Map([["mate", { x: 400, y: 300 }]]));
  const capture = await shareScreen(eng);
  assert.ok(pcs.mate.added?.includes(capture.track), "the room gets the screen");

  const caller = (await connectAll(eng, ["9"], "page"))["9"];
  assert.equal(eng.isScreenSharing, false, "the room's share does not carry into the call");
  assert.ok(!caller.added?.includes(capture.track), "the caller never got it");
});

test("a screen shared in a call ends with the call and never reaches the room", async () => {
  installMocks();
  FakePC.makeSender = () => fakeSender([]);
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {});
  const pcs = await connectAll(eng, ["mate"]);
  const caller = (await connectAll(eng, ["9"], "page"))["9"];
  eng.updateGains({ x: 100, y: 100 }, new Map([["mate", { x: 400, y: 300 }]]));

  const capture = await shareScreen(eng);
  assert.ok(caller.added?.includes(capture.track), "the call gets the screen");
  assert.ok(!pcs.mate.added?.includes(capture.track), "the room does not");

  eng.endPage("9");
  assert.equal(eng.isScreenSharing, false, "hanging up stops the share");
  assert.ok(!pcs.mate.added?.includes(capture.track), "it did not fall through to the room");
});

test("switching spaces ends a share meant for the room left behind", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {});
  eng.updateGains({ x: 100, y: 100 }, new Map());
  const capture = await shareScreen(eng);

  eng.disconnectAllProximity();
  assert.equal(eng.isScreenSharing, false);
  assert.equal(capture.track.stopped, true);
});

// --- Camera in a group place ------------------------------------------------

/** Turn on a camera whose permission prompt returns straight away. */
async function startCamera(eng) {
  const capture = deferredCapture();
  navigator.mediaDevices.getUserMedia = capture.request;
  const starting = eng.startCamera();
  capture.release();
  await starting;
  return capture;
}

test("a camera in the meeting room reaches the people inside, capped for the fan-out", async () => {
  installMocks();
  const log = [];
  FakePC.makeSender = () => fakeSender(log);
  const eng = new AudioEngine();
  eng.init(LOBBY, () => {}, () => {});
  const pcs = await connectAll(eng, ["in", "out"]);
  eng.updateGains(IN_ROOM, new Map([["in", { x: 700, y: 200 }], ["out", { x: 470, y: 100 }]]));

  const capture = await startCamera(eng);
  assert.equal(eng.isCameraOn, true);
  assert.ok(pcs.in.added?.includes(capture.track), "the peer in the room sees the camera");
  assert.ok(!pcs.out.added?.includes(capture.track), "the peer through the wall does not");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(log.find((e) => e.op === "setParameters")?.maxBitrate, 800_000);
});

test("walking out of the meeting room turns the camera off", async () => {
  installMocks();
  FakePC.makeSender = () => fakeSender([]);
  const eng = new AudioEngine();
  eng.init(LOBBY, () => {}, () => {});
  const positions = new Map([["in", { x: 700, y: 200 }]]);
  await connectAll(eng, ["in"]);
  eng.updateGains(IN_ROOM, positions);
  const capture = await startCamera(eng);

  eng.updateGains(OUT_OF_ROOM, positions);
  assert.equal(eng.isCameraOn, false, "the camera went off at the door");
  assert.equal(capture.track.stopped, true, "the camera was released");
});

test("a camera in a call goes to the caller only, at the default bitrate", async () => {
  installMocks();
  const log = [];
  FakePC.makeSender = () => fakeSender(log);
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {});
  const pcs = await connectAll(eng, ["mate"]);
  const caller = (await connectAll(eng, ["9"], "page"))["9"];
  eng.updateGains({ x: 100, y: 100 }, new Map([["mate", { x: 400, y: 300 }]]));

  const capture = await startCamera(eng);
  assert.ok(caller.added?.includes(capture.track), "the call gets the camera");
  assert.ok(!pcs.mate.added?.includes(capture.track), "the room does not");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(log.find((e) => e.op === "setParameters")?.maxBitrate, undefined);
});

test("a room peer's screen reaches the viewer, not only a caller's", async () => {
  installMocks();
  const seen = [];
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {}, undefined, (peerId, videos) => seen.push({ peerId, ...videos }));
  const pc = (await connectAll(eng, ["mate"]))["mate"];

  const track = fakeVideoTrack();
  const stream = new FakeMediaStream([track]);
  pc.fire("track", { streams: [stream], track });
  await eng.handleSignal("mate", { kind: "video-mode", mode: "screen" });
  assert.deepEqual(seen.at(-1), { peerId: "mate", screen: stream, camera: null });
});

// --- Screen share audio ------------------------------------------------------

test("a screen share with the picker's sound sends it to the call under the screen's stream, and stops it with the share", async () => {
  const { eng, pc } = await inCall(true);

  const capture = await shareScreen(eng, true);
  assert.deepEqual(pc.added, [capture.track, capture.audio], "the screen, then its sound");

  eng.stopScreenShare();
  assert.deepEqual(new Set(pc.removed), new Set([capture.track, capture.audio]), "both senders are taken off");
  assert.ok(capture.audio.stopped, "the audio capture is released");
});

test("a peer on an older version gets the screen without its sound, and the sound once it says two-videos", async () => {
  const { eng, pc } = await inCall(false);

  const capture = await shareScreen(eng, true);
  assert.deepEqual(pc.added, [capture.track], "it would take the sound for our voice: the screen alone");

  await eng.handleSignal("9", { kind: "two-videos" });
  assert.deepEqual(pc.added, [capture.track, capture.audio], "a peer of this generation gets the sound too");
});

test("on a Mac the engine asks the host for the sound and sends it with the screen", async () => {
  const { eng, pc } = await inCall(true);
  const hostTrack = fakeAudioTrack();
  let stops = 0;
  eng.setSystemAudioSource(async () => ({ track: hostTrack, stop: () => { stops++; } }));

  const capture = await shareScreen(eng);
  assert.deepEqual(pc.added, [capture.track, hostTrack], "the host's sound goes with the screen");
  assert.equal(stops, 0, "the capture runs with the share");

  eng.stopScreenShare();
  assert.equal(stops, 1, "ending the share ends the host's capture");
  assert.ok(hostTrack.stopped, "and its track");
});

test("a host that has no sound to give leaves the share silent and on", async () => {
  const { eng, pc } = await inCall(true);
  eng.setSystemAudioSource(async () => null);

  const capture = await shareScreen(eng);
  assert.deepEqual(pc.added, [capture.track], "the screen alone");
  assert.equal(eng.isScreenSharing, true);
});

/** A share whose picker lands at once but whose host capture waits for the test. */
function shareWithPendingHost(eng) {
  let land;
  let stops = 0;
  eng.setSystemAudioSource(() => new Promise((resolve) => { land = resolve; }));
  const capture = deferredCapture();
  navigator.mediaDevices.getDisplayMedia = capture.request;
  const sharing = eng.startScreenShare();
  capture.release();
  return {
    capture,
    sharing,
    land: () => land({ track: fakeAudioTrack(), stop: () => { stops++; } }),
    stops: () => stops,
  };
}

test("a host capture that lands after hang-up is ended, not sent", async () => {
  const { eng, pc } = await inCall(true);
  const share = shareWithPendingHost(eng);
  await tick(); // the picker lands; the host is asked
  eng.endPage("9");
  share.land();
  await share.sharing;

  assert.equal(share.stops(), 1, "the capture was ended on arrival");
  assert.ok(share.capture.track.stopped, "and the screen capture with it");
  assert.equal(eng.isScreenSharing, false);
  assert.equal(pc.added, undefined, "nothing was sent");
});

test("a screen the OS stopped while the host was asked is not shared with live sound", async () => {
  const { eng, pc } = await inCall(true);
  const share = shareWithPendingHost(eng);
  await tick();
  share.capture.track.stop(); // the menu bar's "stop sharing": `ended` fired with nobody listening
  share.land();
  await share.sharing;

  assert.equal(share.stops(), 1, "the capture was ended on arrival");
  assert.equal(eng.isScreenSharing, false, "a dead picture is not shared");
  assert.equal(pc.added, undefined, "nothing was sent");
});

test("the sound follows the screen beside the camera, and leaves with the screen", async () => {
  const { eng, pc } = await inCall(true);
  const camera = await startCamera(eng);
  const capture = await shareScreen(eng, true);
  assert.deepEqual(pc.added, [camera.track, capture.track, capture.audio]);
  assert.equal(pc.removed, undefined, "the camera stays");

  eng.stopScreenShare();
  assert.deepEqual(new Set(pc.removed), new Set([capture.track, capture.audio]), "both go when the share does");
  assert.equal(eng.isCameraOn, true);
});

test("a peer's screen sound plays in full with no speaking ring, and the room's goes quiet during a call", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {});
  const pcs = await connectAll(eng, ["mate"]);

  // Their screen arrives as video + audio under one stream, video first.
  const video = fakeVideoTrack();
  const audio = fakeAudioTrack();
  const stream = new FakeMediaStream([video, audio]);
  pcs.mate.fire("track", { track: video, streams: [stream] });
  pcs.mate.fire("track", { track: audio, streams: [stream] });
  const gain = FakeGain.instances.at(-1);
  const sink = FakeAudio.instances.at(-1);
  assert.equal(sink.muted, true, "the pump sink is muted; the gain path plays");

  eng.updateGains({ x: 100, y: 100 }, new Map([["mate", { x: 700, y: 500 }]]));
  assert.equal(gain.gain.value, 1, "full, however far away they stand");
  assert.equal(eng.pollLevels(), false, "a screen does not meter as a voice");
  assert.equal(eng.getLevel("mate"), 0);

  await connectAll(eng, ["9"], "page");
  eng.updateGains({ x: 100, y: 100 }, new Map([["mate", { x: 700, y: 500 }]]));
  assert.equal(gain.gain.value, 0, "a call of ours takes the ears");
  eng.endPage("9");
  eng.updateGains({ x: 100, y: 100 }, new Map([["mate", { x: 700, y: 500 }]]));
  assert.equal(gain.gain.value, 1, "and gives them back");

  eng.disconnect("mate");
  assert.equal(sink.paused, true, "closing the peer releases the sink");
});

test("a screen's sound that arrives before its video is still told from a voice by the peer's label", async () => {
  installMocks();
  const eng = new AudioEngine();
  eng.init(TEAM, () => {}, () => {});
  const pc = (await connectAll(eng, ["mate"]))["mate"];

  const stream = new FakeMediaStream([]);
  await eng.handleSignal("mate", { kind: "video-mode", mode: "screen", streams: { screen: stream.id, camera: null } });
  const audio = fakeAudioTrack();
  stream.addTrack(audio);
  pc.fire("track", { track: audio, streams: [stream] });
  eng.updateGains({ x: 100, y: 100 }, new Map([["mate", { x: 700, y: 500 }]]));
  assert.equal(FakeGain.instances.at(-1).gain.value, 1, "played as a screen's sound, not as a far-off voice");
  assert.equal(eng.pollLevels(), false, "and not metered");
});
