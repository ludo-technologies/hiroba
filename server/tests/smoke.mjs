// End-to-end protocol smoke test for the Hiroba server (wire v2).
// Drives the running server with simulated WebSocket clients and asserts the
// wire protocol behaves per PROTOCOL.md. Uses Node's global WebSocket.
//
// Usage: HIROBA_WS=ws://127.0.0.1:8799/ws node smoke.mjs
const URL = process.env.HIROBA_WS || "ws://127.0.0.1:8799/ws";

let failures = 0;
function ok(cond, msg) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.ws = new WebSocket(URL);
    this.ws.addEventListener("message", (e) => this.msgs.push(JSON.parse(e.data)));
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", rej);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  // Wait until a message matching pred arrives (or timeout). Returns it.
  async wait(pred, ms = 2000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const m = this.msgs.find(pred);
      if (m) return m;
      await sleep(20);
    }
    return null;
  }
  drain(t) { return this.msgs.filter((m) => m.t === t); }
  clear() { this.msgs.length = 0; }
  close() { this.ws.close(); }
}

(async () => {
  console.log(`Connecting to ${URL}`);

  // ── 1) A joins → welcome (both scopes) ──────────────────────────────────
  const A = new Client("A");
  await A.ready;
  A.send({ t: "hello", name: "Aoi", color: "#4f9dde" });
  const wA = await A.wait((m) => m.t === "welcome");
  ok(!!wA, "A receives welcome");
  ok(typeof wA?.id === "string", "welcome.id is a string");
  ok(wA?.org?.id && wA?.org?.name, "welcome.org has id + name");
  ok(wA?.spaceId === "lobby", "A lands in the lobby");
  ok(wA?.space?.kind === "lobby", "welcome.space.kind = lobby");
  ok(wA?.space?.nearRadius === 150, "lobby nearRadius = 150 (camelCase)");
  ok(wA?.space?.farRadius === 180, "lobby farRadius = 180 (camelCase)");
  ok(wA?.space?.capacity === 5, "lobby capacity = 5");
  ok(wA?.space?.tickHz >= 10 && wA?.space?.tickHz <= 15, "lobby tickHz in 10..15");
  ok(typeof wA?.space?.capacity === "number", "space carries a capacity");
  ok(wA?.you?.muted === true, "A starts muted (FR-12)");
  ok(Array.isArray(wA?.peers) && wA.peers.length === 0, "A sees no in-space peers yet");
  ok(Array.isArray(wA?.roster) && wA.roster.length === 0, "A sees an empty roster");
  const lobby = wA.spaces.find((s) => s.id === "lobby");
  const team = wA.spaces.find((s) => s.kind === "team");
  ok(!!lobby && !!team, "catalog has a lobby + a default team space");
  ok(team?.nearRadius >= Math.hypot(team.width, team.height) - 1, "team radius ≥ diagonal (group call)");
  const idA = wA.id;

  // ── 2) B joins → A gets presence (org) + space_joined (lobby) ────────────
  const B = new Client("B");
  await B.ready;
  B.send({ t: "hello", name: "Ren", color: "#e0708a" });
  const wB = await B.wait((m) => m.t === "welcome");
  ok(!!wB, "B receives welcome");
  ok(wB?.roster?.some((m) => m.id === idA), "B's roster contains A (org scope)");
  ok(wB?.peers?.some((p) => p.id === idA), "B's in-space peers contains A (same space)");
  const idB = wB.id;

  const presBonA = await A.wait((m) => m.t === "presence" && m.member?.id === idB);
  ok(!!presBonA, "A receives presence for B (org roster upsert)");
  ok(presBonA?.member?.spaceId === "lobby", "presence.member.spaceId = lobby");
  ok(presBonA?.member?.status === "active", "B's effective status is active");
  const joinedBonA = await A.wait((m) => m.t === "space_joined" && m.peer?.id === idB);
  ok(!!joinedBonA, "A receives space_joined for B (space scope)");
  ok(joinedBonA?.peer?.name === "Ren", "space_joined carries B's name");

  // ── 3) Lobby proximity (v1 mechanics, now space-scoped) ─────────────────
  const { width, height } = wA.space;
  A.send({ t: "move", x: 50, y: 50 });
  B.send({ t: "move", x: width - 50, y: height - 50 });
  await sleep(400);
  A.clear(); B.clear();
  await sleep(300);
  ok(A.drain("proximity").length === 0, "no proximity connect while far apart");

  const stateA = await A.wait((m) => m.t === "state" && m.peers?.some((p) => p.id === idB));
  ok(!!stateA, "A receives state containing B");
  ok(!stateA?.peers?.some((p) => p.id === idA), "state excludes the recipient (A)");

  A.clear(); B.clear();
  A.send({ t: "move", x: 500, y: 500 });
  B.send({ t: "move", x: 510, y: 505 });
  const proxA = await A.wait((m) => m.t === "proximity" && m.connect?.length);
  const proxB = await B.wait((m) => m.t === "proximity" && m.connect?.length);
  const cA = proxA?.connect?.find((c) => c.id === idB);
  const cB = proxB?.connect?.find((c) => c.id === idA);
  ok(!!cA && !!cB, "each peer is told to connect to the other");
  const aSmaller = Number(idA) < Number(idB);
  ok(cA?.initiator === aSmaller && cB?.initiator === !aSmaller, "initiator tie-break by smaller id");
  ok(cA?.initiator !== cB?.initiator, "exactly one initiator per pair (no glare)");

  // signal relay (used by both proximity + page links)
  B.clear();
  A.send({ t: "signal", to: idB, data: { kind: "offer", sdp: "FAKE_SDP" } });
  const sig = await B.wait((m) => m.t === "signal");
  ok(sig?.from === idA && sig?.data?.sdp === "FAKE_SDP", "signal relayed verbatim with from = A");

  // mute → space `mute` + org `presence`
  A.clear();
  B.send({ t: "mute", muted: false });
  const muteOnA = await A.wait((m) => m.t === "mute" && m.id === idB);
  ok(muteOnA?.muted === false, "A receives B's space mute change");
  const presMute = await A.wait((m) => m.t === "presence" && m.member?.id === idB && m.member?.muted === false);
  ok(!!presMute, "mute is also reflected in the org roster (presence)");

  // move apart → proximity disconnect (hysteresis)
  A.clear();
  A.send({ t: "move", x: 50, y: 50 });
  B.send({ t: "move", x: width - 50, y: height - 50 });
  const disc = await A.wait((m) => m.t === "proximity" && m.disconnect?.includes(idB), 3000);
  ok(!!disc, "A receives proximity disconnect after moving apart");

  // ── 4) Space switch + isolation ─────────────────────────────────────────
  A.clear(); B.clear();
  B.send({ t: "enter_space", spaceId: team.id });
  const snapB = await B.wait((m) => m.t === "space_snapshot");
  ok(snapB?.spaceId === team.id, "B receives space_snapshot for the team space");
  ok(snapB?.space?.kind === "team", "snapshot carries the team space config");
  ok(Array.isArray(snapB?.peers) && snapB.peers.length === 0, "team space is empty for B");
  const leftBonA = await A.wait((m) => m.t === "space_left" && m.id === idB);
  ok(!!leftBonA, "A receives space_left for B (B left the lobby)");
  const presMove = await A.wait((m) => m.t === "presence" && m.member?.id === idB && m.member?.spaceId === team.id);
  ok(!!presMove, "A still sees B in the org roster, now in the team space");

  // Now in different spaces: positions must not cross over.
  A.clear(); B.clear();
  A.send({ t: "move", x: 500, y: 500 });
  B.send({ t: "move", x: 300, y: 300 });
  await sleep(500);
  ok(!A.drain("state").some((m) => m.peers?.some((p) => p.id === idB)), "A never sees B's position across spaces");
  ok(A.drain("proximity").length === 0, "no cross-space proximity between A and B");

  // ── 5) create_space → catalog broadcast ─────────────────────────────────
  A.clear(); B.clear();
  A.send({ t: "create_space", name: "Design" });
  const spacesA = await A.wait((m) => m.t === "spaces" && m.spaces?.some((s) => s.name === "Design"));
  const spacesB = await B.wait((m) => m.t === "spaces" && m.spaces?.some((s) => s.name === "Design"));
  ok(!!spacesA && !!spacesB, "create_space broadcasts the new catalog to the whole org");
  const design = spacesA?.spaces?.find((s) => s.name === "Design");
  ok(design?.kind === "team" && design?.capacity === 5, "created space is a team (capacity 5)");

  // ── 6) set_status → presence ────────────────────────────────────────────
  A.clear(); B.clear();
  A.send({ t: "set_status", dnd: true });
  const presDnd = await B.wait((m) => m.t === "presence" && m.member?.id === idA && m.member?.status === "dnd");
  ok(!!presDnd, "set_status dnd is reflected in A's roster status (seen by B)");

  // ── 7) Paging (cross-space 1:1) ─────────────────────────────────────────
  // A is DND → page is rejected.
  B.clear();
  B.send({ t: "page", to: idA });
  const rej = await B.wait((m) => m.t === "page_rejected" && m.to === idA);
  ok(rej?.reason === "dnd", "paging a DND member is rejected with reason=dnd");

  // A clears DND → page connects both peers (cross-space) + sets in_call.
  A.clear(); B.clear();
  A.send({ t: "set_status", dnd: false });
  await B.wait((m) => m.t === "presence" && m.member?.id === idA && m.member?.status === "active");
  B.clear(); A.clear();
  B.send({ t: "page", to: idA });
  const pcB = await B.wait((m) => m.t === "page_connect" && m.peer === idA);
  const pcA = await A.wait((m) => m.t === "page_connect" && m.peer === idB);
  ok(!!pcA && !!pcB, "both peers receive page_connect");
  ok(pcA.initiator !== pcB.initiator, "page has exactly one initiator (tie-break)");
  const callPres = await B.wait((m) => m.t === "presence" && m.member?.id === idA && m.member?.status === "in_call");
  ok(!!callPres, "paged peer's status becomes in_call in the roster");

  // page_end → other side notified, in_call cleared.
  A.clear(); B.clear();
  B.send({ t: "page_end", to: idA });
  const endA = await A.wait((m) => m.t === "page_end" && m.from === idB);
  ok(!!endA, "page_end is relayed to the other peer");
  const clearPres = await B.wait((m) => m.t === "presence" && m.member?.id === idA && m.member?.status !== "in_call");
  ok(!!clearPres, "in_call is cleared after page_end");

  // ── 8) Disconnect → presence_left ───────────────────────────────────────
  A.clear();
  B.send({ t: "bye" });
  const leftOrg = await A.wait((m) => m.t === "presence_left" && m.id === idB);
  ok(!!leftOrg, "A receives presence_left after B says bye");

  A.close(); B.close();
  await sleep(100);

  console.log(failures === 0 ? "\nALL PROTOCOL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("smoke test crashed:", e); process.exit(2); });
