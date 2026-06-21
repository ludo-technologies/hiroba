// Auth + multi-tenant smoke test for the Hiroba server (FR-13 / §9 / §7.6).
// Run against a server started in HS256 JWT mode:
//
//   HIROBA_ADDR=127.0.0.1:8798 HIROBA_AUTH=jwt HIROBA_JWT_SECRET=testsecret \
//     cargo run &
//   HIROBA_WS=ws://127.0.0.1:8798/ws HIROBA_JWT_SECRET=testsecret \
//     node tests/auth.mjs
//
// Mints HS256 tokens with Node's built-in crypto (no dependencies) and asserts:
//   - a valid token connects and lands in the org named by its `org` claim,
//   - a missing token is rejected with `auth_failed`,
//   - a token signed with the wrong secret is rejected,
//   - two tokens for different orgs are isolated (no cross-tenant roster leak).
import crypto from "node:crypto";

const URL = process.env.HIROBA_WS || "ws://127.0.0.1:8798/ws";
const SECRET = process.env.HIROBA_JWT_SECRET || "testsecret";
const ICE_URL = URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/ws$/, "/ice");

let failures = 0;
function ok(cond, msg) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Mint an HS256 JWT with the given claims and signing secret.
function mint(claims, secret = SECRET) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = b64url(JSON.stringify({ exp, ...claims }));
  const data = `${header}.${payload}`;
  const sig = b64url(crypto.createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

class Client {
  constructor() {
    this.msgs = [];
    this.ws = new WebSocket(URL);
    this.ws.addEventListener("message", (e) => this.msgs.push(JSON.parse(e.data)));
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", rej);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async wait(pred, ms = 2000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const m = this.msgs.find(pred);
      if (m) return m;
      await sleep(20);
    }
    return null;
  }
  close() { this.ws.close(); }
}

(async () => {
  console.log(`Connecting to ${URL} (JWT auth)`);

  // ── 1) Valid token → welcome, lands in the claimed org ──────────────────
  const tokenA = mint({ sub: "u-a", org: "acme", name: "Aoi" });
  const A = new Client();
  await A.ready;
  A.send({ t: "hello", token: tokenA });
  const wA = await A.wait((m) => m.t === "welcome");
  ok(!!wA, "valid token receives welcome");
  ok(wA?.org?.id === "acme", "lands in the org named by the token's `org` claim");

  // ── 1b) /ice follows the same auth boundary as WebSocket hello ───────────
  const iceOk = await fetch(ICE_URL, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  ok(iceOk.ok, "/ice accepts a valid bearer token");
  const iceBody = await iceOk.json();
  ok(Array.isArray(iceBody.iceServers), "/ice returns an ICE server list");
  const iceMissing = await fetch(ICE_URL);
  ok(iceMissing.status === 401, "/ice rejects missing token in JWT mode");

  // ── 2) Missing token → auth_failed ──────────────────────────────────────
  const B = new Client();
  await B.ready;
  B.send({ t: "hello", name: "NoToken" });
  const eB = await B.wait((m) => m.t === "error");
  ok(eB?.code === "auth_failed", "missing token rejected with auth_failed");

  // ── 3) Wrong-secret token → auth_failed ─────────────────────────────────
  const C = new Client();
  await C.ready;
  C.send({ t: "hello", token: mint({ sub: "u-c", org: "acme" }, "WRONG-SECRET") });
  const eC = await C.wait((m) => m.t === "error");
  ok(eC?.code === "auth_failed", "wrong-secret token rejected with auth_failed");

  // ── 4) Tenant isolation: a member in a different org is invisible ───────
  const D = new Client();
  await D.ready;
  D.send({ t: "hello", token: mint({ sub: "u-d", org: "globex", name: "Dai" }) });
  const wD = await D.wait((m) => m.t === "welcome");
  ok(wD?.org?.id === "globex", "D lands in its own org (globex)");
  // A (in acme) must not receive any presence for D (in globex).
  const leak = await A.wait((m) => m.t === "presence" && m.member?.name === "Dai", 500);
  ok(!leak, "no cross-tenant presence leak (NFR-12)");

  A.close(); B.close(); C.close(); D.close();
  await sleep(100);

  console.log(failures === 0 ? "\nALL AUTH CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 1 - 1 : 1);
})();
