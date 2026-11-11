/**
 * Tests for src/auth.ts: the invite normalizer the browser client applies to
 * `?invite=` (`extractInviteCode`, which accepts a bare code or a shared https
 * link), the deep-link parser (`parseAuthDeepLink`, hiroba://auth/<code>
 * only) and its redemption (`redeemHandoff`), plus the e-mail one-time-code
 * client (`sanitizeCode`, `emailStart`, `emailVerify`). Each session call is
 * checked twice where the two builds part: under Tauri (`withTauri`, tokens
 * in the body, keychain) and in the browser (no `window.__TAURI__`, the
 * refresh token an HttpOnly cookie behind `/web/*`).
 *
 * Run via `npm test` (compiled first by tsc into .test-build/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askToJoin,
  colleagueOrgs,
  CODE_LENGTH,
  CodeRejectedError,
  CodeThrottledError,
  HandoffRejectedError,
  InviteRejectedError,
  OrgCreateRefusedError,
  clearSession,
  createOrg,
  emailStart,
  emailVerify,
  extractInviteCode,
  guestLogin,
  listOrgs,
  loadSession,
  parseAuthDeepLink,
  redeemHandoff,
  sanitizeCode,
  saveSession,
  supersedeRestore,
  switchOrg,
} from "../.test-build/auth.js";

/** Swap in a stub `fetch` for one call, recording what it received. */
async function withFetch(handler, body) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(url, init);
  };
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const jsonResponse = (status, payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("extractInviteCode returns a bare code unchanged", () => {
  assert.equal(extractInviteCode("aB3_x-9"), "aB3_x-9");
});

test("extractInviteCode pulls the token out of a shared link", () => {
  assert.equal(
    extractInviteCode("https://auth.example.com/invite/aB3_x-9"),
    "aB3_x-9",
  );
  assert.equal(
    extractInviteCode("  https://auth.example.com/invite/aB3_x-9/  "),
    "aB3_x-9",
  );
});

test("parseAuthDeepLink accepts hiroba://auth/<code>", () => {
  assert.equal(parseAuthDeepLink("hiroba://auth/aB3_x-9"), "aB3_x-9");
  assert.equal(parseAuthDeepLink(" hiroba://auth/aB3_x-9/ "), "aB3_x-9");
});

test("parseAuthDeepLink rejects everything else", () => {
  assert.equal(parseAuthDeepLink("hiroba://auth/"), null);
  assert.equal(parseAuthDeepLink("hiroba://other/aB3"), null);
  // The retired invite link: no page emits it any more, and a token is not a code.
  assert.equal(parseAuthDeepLink("hiroba://invite/aB3_x-9"), null);
  assert.equal(parseAuthDeepLink("https://auth.example.com/invite/aB3"), null);
  assert.equal(parseAuthDeepLink("hiroba://auth/bad token"), null);
  assert.equal(parseAuthDeepLink("hiroba://auth/a?x=1"), null);
  assert.equal(parseAuthDeepLink(`hiroba://auth/${"a".repeat(129)}`), null);
});

// ---------------------------------------------------------------------------
// Web sign-in handoff (POST /handoff)
// ---------------------------------------------------------------------------

test("redeemHandoff trades the code for the session it names", async () => {
  // Payload of a real session JWT: {"sub":"google:1","org":"acme","exp":9999999999}
  const claims = Buffer.from(
    JSON.stringify({ sub: "google:1", org: "acme", exp: 9999999999 }),
  ).toString("base64url");
  const token = `h.${claims}.s`;
  const tauri = withTauri();
  try {
    const { result, calls } = await withFetch(
      () => jsonResponse(200, { token, refresh_token: "r1" }),
      () => redeemHandoff("https://auth.example.com/", "c0de"),
    );
    assert.equal(calls[0].url, "https://auth.example.com/handoff");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].body, { code: "c0de" });
    assert.equal(result.token, token);
    assert.equal(result.refreshToken, "r1");
    assert.equal(result.claims.org, "acme");
  } finally {
    tauri.restore();
  }
});

test("the browser collects a handoff into its session cookie", async () => {
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { token: jwt(43200) }),
    () => redeemHandoff("https://auth.example.com/", "c0de"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/web/handoff");
  // The cookie is what the auth server sets and later reads back.
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(calls[0].body, { code: "c0de" });
  assert.equal(result.refreshToken, null);
  assert.equal(result.claims.sub, "email:aoi@example.com");
});

test("redeemHandoff tells a refused code apart from a failed request", async () => {
  // 401 is the code itself (spent or expired) — the membership behind it
  // stands, so the caller sends the user to an ordinary sign-in.
  await assert.rejects(
    withFetch(
      () => new Response("handoff code invalid, used, or expired", { status: 401 }),
      () => redeemHandoff("https://auth.example.com", "c0de"),
    ),
    HandoffRejectedError,
  );
  await assert.rejects(
    withFetch(
      () => new Response("storage error", { status: 500 }),
      () => redeemHandoff("https://auth.example.com", "c0de"),
    ),
    (err) => !(err instanceof HandoffRejectedError),
  );
  const { result: malformed } = await withFetch(
    () => jsonResponse(200, { token: "not-a-jwt", refresh_token: "r1" }),
    () => redeemHandoff("https://auth.example.com", "c0de").catch((e) => e),
  );
  assert.match(malformed.message, /malformed token/);
});

test("sanitizeCode keeps only digits, capped at the code length", () => {
  assert.equal(sanitizeCode("012345"), "012345");
  // Pasting the surrounding text still yields the code.
  assert.equal(sanitizeCode("code: 012 345"), "012345");
  assert.equal(sanitizeCode("0123456789"), "0123456789".slice(0, CODE_LENGTH));
  assert.equal(sanitizeCode("abc"), "");
});

test("emailStart posts the address and surfaces a dev code", async () => {
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { sent: true, dev_code: "012345" }),
    () => emailStart("https://auth.example.com/", "Aoi@Example.com", "ja"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/email/start");
  assert.deepEqual(calls[0].body, { email: "Aoi@Example.com", locale: "ja" });
  assert.equal(result.devCode, "012345");
});

test("emailStart reports throttling with the server's wait", async () => {
  const { result: err } = await withFetch(
    () => jsonResponse(429, {}, { "retry-after": "42" }),
    () => emailStart("https://auth.example.com", "aoi@example.com", "en").catch((e) => e),
  );
  assert.ok(err instanceof CodeThrottledError);
  assert.equal(err.retryAfterSecs, 42);
});

test("emailStart falls back to a minute when Retry-After is unusable", async () => {
  const { result: err } = await withFetch(
    () => jsonResponse(429, {}),
    () => emailStart("https://auth.example.com", "aoi@example.com", "en").catch((e) => e),
  );
  assert.ok(err instanceof CodeThrottledError);
  assert.equal(err.retryAfterSecs, 60);
});

test("emailVerify returns a session", async () => {
  // Payload of a real session JWT: {"sub":"email:aoi@example.com","exp":9999999999}
  const claims = Buffer.from(
    JSON.stringify({ sub: "email:aoi@example.com", exp: 9999999999 }),
  ).toString("base64url");
  const token = `h.${claims}.s`;
  const tauri = withTauri();
  try {
    const { result, calls } = await withFetch(
      () => jsonResponse(200, { token, refresh_token: "r1" }),
      () => emailVerify("https://auth.example.com", "aoi@example.com", "012345"),
    );
    assert.equal(calls[0].url, "https://auth.example.com/email/verify");
    // Membership is settled on the web now; a sign-in carries no invite.
    assert.deepEqual(calls[0].body, { email: "aoi@example.com", code: "012345" });
    assert.equal(result.kind, "session");
    assert.equal(result.session.refreshToken, "r1");
    assert.equal(result.session.claims.sub, "email:aoi@example.com");
  } finally {
    tauri.restore();
  }
});

test("the browser's e-mail sign-in collects the handoff it answers with", async () => {
  const { result, calls } = await withFetch(
    (url) =>
      url.endsWith("/web/email/verify")
        ? jsonResponse(200, { handoff: "h4nd" })
        : jsonResponse(200, { token: jwt(43200) }),
    () => emailVerify("https://auth.example.com", "aoi@example.com", "012345"),
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    ["https://auth.example.com/web/email/verify", "https://auth.example.com/web/handoff"],
  );
  assert.deepEqual(calls[1].body, { code: "h4nd" });
  assert.equal(result.kind, "session");
  assert.equal(result.session.refreshToken, null);
});

test("emailVerify surfaces the org-setup handoff", async () => {
  const { result } = await withFetch(
    () => jsonResponse(200, { pending: "org_setup", provisional_token: "p1" }),
    () => emailVerify("https://auth.example.com", "aoi@example.com", "012345"),
  );
  assert.deepEqual(result, { kind: "pending_org", provisionalToken: "p1" });
});

test("emailVerify rejects a refused code and a malformed session", async () => {
  const { result: refused } = await withFetch(
    () => new Response("code invalid or expired", { status: 401 }),
    () => emailVerify("https://auth.example.com", "aoi@example.com", "999999").catch((e) => e),
  );
  // Typed, so a refused code reads differently from a request that never landed.
  assert.ok(refused instanceof CodeRejectedError);

  const { result: malformed } = await withFetch(
    () => jsonResponse(200, { token: "not-a-jwt", refresh_token: "r1" }),
    () => emailVerify("https://auth.example.com", "aoi@example.com", "012345").catch((e) => e),
  );
  assert.match(malformed.message, /malformed token/);
});

// ---------------------------------------------------------------------------
// Org membership (multi-org: list + refresh-based switch)
// ---------------------------------------------------------------------------

test("listOrgs sends the bearer and returns the memberships", async () => {
  const orgs = [
    { slug: "beta", name: "Beta", role: "member" },
    { slug: "acme", name: "Acme", role: "admin" },
  ];
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { orgs }),
    () => listOrgs("https://auth.example.com/", "tok"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/orgs");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(result, orgs);
});

test("listOrgs throws on a refusal or a malformed answer", async () => {
  for (const answer of [
    () => new Response("invalid token", { status: 401 }),
    () => jsonResponse(200, { orgs: "not-a-list" }),
  ]) {
    const { result } = await withFetch(answer, () =>
      listOrgs("https://auth.example.com", "tok").catch((e) => e),
    );
    assert.ok(result instanceof Error);
  }
});

test("colleagueOrgs lists the orgs on offer, and none where the backend has no such route", async () => {
  const orgs = [{ slug: "acme", name: "Acme", members: 3, requested: false }];
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { orgs }),
    () => colleagueOrgs("https://auth.example.com/", "tok"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/orgs/colleagues");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(result, orgs);

  const older = await withFetch(
    () => new Response("not found", { status: 404 }),
    () => colleagueOrgs("https://auth.example.com", "tok"),
  );
  assert.deepEqual(older.result, []);

  const refused = await withFetch(
    () => new Response("invalid token", { status: 401 }),
    () => colleagueOrgs("https://auth.example.com", "tok").catch((e) => e),
  );
  assert.ok(refused.result instanceof Error);
});

test("askToJoin names the org and the locale, and throws on a refusal", async () => {
  const { calls } = await withFetch(
    () => new Response(null, { status: 204 }),
    () => askToJoin("https://auth.example.com", "tok", "acme", "ja"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/orgs/colleagues/ask");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(calls[0].body, { org: "acme", locale: "ja" });

  const { result } = await withFetch(
    () => new Response("not an organization you can ask", { status: 403 }),
    () => askToJoin("https://auth.example.com", "tok", "acme", "ja").catch((e) => e),
  );
  assert.ok(result instanceof Error);
});

/** A session as the app holds one (`refresh`) or the browser does (`null`). */
const held = (refreshToken) => ({ token: jwt(3600), claims: { exp: 0 }, refreshToken });

test("switchOrg posts the refresh token with the target org and adopts the answer", async () => {
  const fresh = jwt(43200);
  const tauri = withTauri();
  try {
    const { result, calls } = await withFetch(
      () => jsonResponse(200, { token: fresh, refresh_token: "r2" }),
      () => switchOrg("https://auth.example.com", held("r1"), "beta"),
    );
    assert.equal(calls[0].url, "https://auth.example.com/refresh");
    assert.deepEqual(calls[0].body, { refresh_token: "r1", org: "beta" });
    assert.equal(result.token, fresh);
    assert.equal(result.refreshToken, "r2");
    assert.equal(result.claims.sub, "email:aoi@example.com");
  } finally {
    tauri.restore();
  }
});

test("the browser switches orgs through its session cookie", async () => {
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { token: jwt(43200) }),
    () => switchOrg("https://auth.example.com", held(null), "beta"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/web/session");
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(calls[0].body, { org: "beta" });
  assert.equal(result.refreshToken, null);
});

test("switchOrg throws on a refusal and on a malformed session", async () => {
  const tauri = withTauri();
  try {
    for (const answer of [
      () => new Response("invalid refresh token", { status: 401 }),
      () => jsonResponse(200, { token: "not-a-jwt", refresh_token: "r2" }),
      () => jsonResponse(200, { token: jwt(43200) }), // no refresh token
    ]) {
      const { result } = await withFetch(answer, () =>
        switchOrg("https://auth.example.com", held("r1"), "beta").catch((e) => e),
      );
      assert.ok(result instanceof Error);
    }
  } finally {
    tauri.restore();
  }
});

test("createOrg founds the org with the token it is given, in either build", async () => {
  const tauri = withTauri();
  try {
    const { result, calls } = await withFetch(
      () => jsonResponse(200, { token: jwt(43200), refresh_token: "r1" }),
      () => createOrg("https://auth.example.com", "prov", { name: "Acme" }),
    );
    assert.equal(calls[0].url, "https://auth.example.com/orgs");
    assert.equal(calls[0].init.headers.Authorization, "Bearer prov");
    assert.deepEqual(calls[0].body, { name: "Acme" });
    assert.equal(result.refreshToken, "r1");
  } finally {
    tauri.restore();
  }
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { token: jwt(43200) }),
    () => createOrg("https://auth.example.com", "prov", { name: "Acme" }),
  );
  assert.equal(calls[0].url, "https://auth.example.com/web/orgs");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.headers.Authorization, "Bearer prov");
  assert.equal(result.refreshToken, null);

  const { result: refused } = await withFetch(
    () => new Response("invalid token", { status: 401 }),
    () => createOrg("https://auth.example.com", "prov", { name: "Acme" }).catch((e) => e),
  );
  assert.ok(refused instanceof OrgCreateRefusedError);
  assert.equal(refused.status, 401);
});

// ---------------------------------------------------------------------------
// Session restore (keychain + renewal)
//
// The failure these guard against is the expensive one: a stored session the
// app quietly gives up on, so the user is asked to sign in again on a machine
// that never actually lost anything.
// ---------------------------------------------------------------------------

/** A session JWT expiring `secs` from now (negative = already expired). */
const jwt = (secs) =>
  `h.${Buffer.from(
    JSON.stringify({ sub: "email:aoi@example.com", exp: Math.floor(Date.now() / 1000) + secs }),
  ).toString("base64url")}.s`;

/** Stand in for the Tauri shell: a keychain in a Map, plus whatever `secret_*`
 *  failure the test wants to provoke. Returns the calls for assertions. */
function withTauri({ store = new Map(), failLoad = false, failSave = false, gate } = {}) {
  const calls = [];
  globalThis.window = {
    __TAURI__: {
      core: {
        async invoke(cmd, args) {
          calls.push(cmd);
          if (cmd === "secret_load") {
            if (failLoad) throw new Error("keychain locked");
            return store.get(args.key) ?? null;
          }
          if (cmd === "secret_save") {
            if (failSave) throw new Error("keychain refused the write");
            // A slow keychain, so a sign-out can be raced against a save.
            if (gate) await gate;
            store.set(args.key, args.value);
            return null;
          }
          if (cmd === "secret_delete") {
            store.delete(args.key);
            return null;
          }
          throw new Error(`unexpected command ${cmd}`);
        },
      },
    },
  };
  return { store, calls, restore: () => delete globalThis.window };
}

const storedSession = (token, refresh = "r1") =>
  new Map([
    ["session-token", token],
    ["refresh-token", refresh],
  ]);

test("loadSession returns a live session without touching the network", async () => {
  const tauri = withTauri({ store: storedSession(jwt(3600)) });
  try {
    const { result, calls } = await withFetch(
      () => assert.fail("a live session must not be renewed"),
      () => loadSession("https://auth.example.com"),
    );
    assert.equal(calls.length, 0);
    assert.equal(result.session.refreshToken, "r1");
    assert.equal(result.problem, undefined);
  } finally {
    tauri.restore();
  }
});

test("loadSession renews an expired session and stores the rotated tokens", async () => {
  const tauri = withTauri({ store: storedSession(jwt(-60)) });
  try {
    const fresh = jwt(43200);
    const { result, calls } = await withFetch(
      () => jsonResponse(200, { token: fresh, refresh_token: "r2" }),
      () => loadSession("https://auth.example.com/"),
    );
    assert.equal(calls[0].url, "https://auth.example.com/refresh");
    assert.deepEqual(calls[0].body, { refresh_token: "r1" });
    assert.equal(result.session.token, fresh);
    assert.equal(result.problem, undefined);
    // The old refresh token is spent server-side, so the rotated pair must land
    // in the keychain or the next launch has nothing to restore.
    assert.equal(tauri.store.get("session-token"), fresh);
    assert.equal(tauri.store.get("refresh-token"), "r2");
  } finally {
    tauri.restore();
  }
});

test("loadSession keeps the stored session when the auth server is unreachable", async () => {
  const stale = jwt(-60);
  const tauri = withTauri({ store: storedSession(stale) });
  try {
    for (const answer of [
      () => Promise.reject(new Error("offline")),
      () => new Response("bad gateway", { status: 502 }),
      () => jsonResponse(200, { token: "not-a-jwt" }),
    ]) {
      const { result } = await withFetch(answer, () => loadSession("https://auth.example.com"));
      // Signed in, just not renewable right now — never a sign-in prompt.
      assert.equal(result.session.token, stale);
      assert.equal(result.problem, "network");
      assert.equal(tauri.store.get("refresh-token"), "r1", "an unspent token must survive");
    }
  } finally {
    tauri.restore();
  }
});

test("loadSession drops the session only when the server disowns it", async () => {
  const tauri = withTauri({ store: storedSession(jwt(-60)) });
  try {
    const { result } = await withFetch(
      () => new Response("invalid refresh token", { status: 401 }),
      () => loadSession("https://auth.example.com"),
    );
    assert.equal(result.session, null);
    assert.equal(result.problem, undefined);
    assert.equal(tauri.store.size, 0, "a disowned session must be cleared");
  } finally {
    tauri.restore();
  }
});

test("loadSession reports a keychain it cannot read instead of looking signed out", async () => {
  const tauri = withTauri({ failLoad: true });
  try {
    const { result } = await loadSession("https://auth.example.com").then((r) => ({ result: r }));
    assert.deepEqual(result, { session: null, problem: "keychain" });
  } finally {
    tauri.restore();
  }
});

test("loadSession flags a renewal it could not persist", async () => {
  const tauri = withTauri({ store: storedSession(jwt(-60)), failSave: true });
  try {
    const { result } = await withFetch(
      () => jsonResponse(200, { token: jwt(43200), refresh_token: "r2" }),
      () => loadSession("https://auth.example.com"),
    );
    // Usable now, but the next launch won't find it — the caller has to say so.
    assert.ok(result.session);
    assert.equal(result.problem, "keychain");
  } finally {
    tauri.restore();
  }
});

test("a sign-out mid-renewal is not undone by the answer that lands after it", async () => {
  const tauri = withTauri({ store: storedSession(jwt(-60)) });
  const real = globalThis.fetch;
  let release;
  const answered = new Promise((r) => (release = r));
  globalThis.fetch = () => answered;
  try {
    const restoring = loadSession("https://auth.example.com");
    // The user signs out while the renewal is still in flight.
    await clearSession("https://auth.example.com");
    release(jsonResponse(200, { token: jwt(43200), refresh_token: "rotated" }));
    const result = await restoring;
    // Neither on screen nor on disk: a renewal can't resurrect a session the
    // user has just discarded.
    assert.equal(result.session, null);
    assert.equal(tauri.store.size, 0);
  } finally {
    globalThis.fetch = real;
    tauri.restore();
  }
});

test("a session adopted mid-renewal is not overwritten by the answer that lands after it", async () => {
  // The app is launched by a hiroba://auth/<code> link with an expired
  // session on disk: the renewal of that (previous-org) session and the
  // handoff's redemption are in flight together.
  const tauri = withTauri({ store: storedSession(jwt(-60)) });
  const real = globalThis.fetch;
  let release;
  const answered = new Promise((r) => (release = r));
  globalThis.fetch = () => answered;
  try {
    const restoring = loadSession("https://auth.example.com");
    // The handoff wins the race: its session is adopted and persisted.
    supersedeRestore();
    await saveSession({ token: jwt(43200), claims: { exp: 0 }, refreshToken: "handoff" });
    release(jsonResponse(200, { token: jwt(43200), refresh_token: "rotated-previous-org" }));
    const result = await restoring;
    // The late renewal neither comes back nor reaches the keychain: the next
    // launch must open in the org the handoff joined, not the previous one.
    assert.equal(result.session, null);
    assert.equal(tauri.store.get("refresh-token"), "handoff");
  } finally {
    globalThis.fetch = real;
    tauri.restore();
  }
});

test("a sign-out queued behind an in-flight save still wins", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const tauri = withTauri({ gate });
  try {
    const saving = saveSession({ token: jwt(3600), claims: { exp: 0 }, refreshToken: "r1" });
    const clearing = clearSession("https://auth.example.com"); // user hits Sign out mid-write
    release();
    await Promise.all([saving, clearing]);
    // The delete runs after the save it was queued behind, not against it.
    assert.equal(tauri.store.size, 0, "an explicit sign-out must be what persists");
  } finally {
    tauri.restore();
  }
});

test("saveSession reports failure instead of throwing away a completed sign-in", async () => {
  const tauri = withTauri({ failSave: true });
  const session = { token: jwt(3600), claims: { exp: 0 }, refreshToken: "r1" };
  try {
    assert.equal(await saveSession(session), "failed");
  } finally {
    tauri.restore();
  }
  // No shell at all (plain-browser build): nothing to persist, nothing to warn about.
  assert.equal(await saveSession(session), "skipped");
});

// ---------------------------------------------------------------------------
// The browser build's session: an HttpOnly cookie on the auth server
// ---------------------------------------------------------------------------

test("the browser restores its session from the cookie, renewing it", async () => {
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { token: jwt(43200) }),
    () => loadSession("https://auth.example.com"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/web/session");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(result.session.refreshToken, null);
  assert.equal(result.problem, undefined);
});

test("the browser reads a 401 as signed out and anything else as the network", async () => {
  const { result: signedOut } = await withFetch(
    () => new Response("no session", { status: 401 }),
    () => loadSession("https://auth.example.com"),
  );
  assert.deepEqual(signedOut, { session: null });
  for (const answer of [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => new Response("storage error", { status: 500 }),
    () => jsonResponse(200, { token: "not-a-jwt" }),
  ]) {
    const { result } = await withFetch(answer, () => loadSession("https://auth.example.com"));
    // Nothing stored to fall back on, but not "sign in again" either.
    assert.deepEqual(result, { session: null, problem: "network" });
  }
});

test("a browser sign-out mid-renewal is not undone by the answer that lands after it", async () => {
  const real = globalThis.fetch;
  let release;
  const answered = new Promise((r) => (release = r));
  const urls = [];
  globalThis.fetch = (url) => {
    urls.push(url);
    return url.endsWith("/web/signout") ? Promise.resolve(new Response(null, { status: 204 })) : answered;
  };
  try {
    const restoring = loadSession("https://auth.example.com");
    const signingOut = clearSession("https://auth.example.com");
    release(jsonResponse(200, { token: jwt(43200) }));
    assert.equal((await restoring).session, null);
    await signingOut;
    // One at a time: the sign-out went out after the renewal rotated the
    // cookie, so it revoked the token the browser actually holds.
    assert.deepEqual(urls, ["https://auth.example.com/web/session", "https://auth.example.com/web/signout"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("a browser sign-out the auth server refuses is not reported as done", async () => {
  const { result } = await withFetch(
    () => new Response("storage error", { status: 500 }),
    () => clearSession("https://auth.example.com").catch((e) => e),
  );
  assert.ok(result instanceof Error);
});

test("guestLogin trades an invite and a name for a refresh-less session", async () => {
  const token = jwt(3600);
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { token }),
    () => guestLogin("https://auth.example.com", "inv-1", "Gen", "g-1"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/guest");
  assert.deepEqual(calls[0].body, { invite: "inv-1", name: "Gen", guestId: "g-1" });
  assert.equal(result.token, token);
  assert.equal(result.refreshToken, "");
  assert.equal(typeof result.claims.exp, "number");
});

test("guestLogin reports a dead invite as InviteRejectedError", async () => {
  await assert.rejects(
    withFetch(
      () => new Response("invite invalid or expired", { status: 409 }),
      () => guestLogin("https://auth.example.com", "inv-1", "Gen", "g-1"),
    ),
    InviteRejectedError,
  );
});

test("guestLogin surfaces other failures as plain errors", async () => {
  await assert.rejects(
    withFetch(
      () => new Response("storage error", { status: 500 }),
      () => guestLogin("https://auth.example.com", "inv-1", "Gen", "g-1"),
    ),
    (err) => !(err instanceof InviteRejectedError),
  );
});

test("guestLogin gives up when its attempt is aborted", async () => {
  const controller = new AbortController();
  await assert.rejects(
    withFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          controller.abort();
        }),
      () => guestLogin("https://auth.example.com", "inv-1", "Gen", "g-1", controller.signal),
    ),
    (err) => err.name === "AbortError",
  );
});
