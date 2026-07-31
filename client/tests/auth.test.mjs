/**
 * Tests for src/auth.ts: the invite-code normalizers — the join-form field
 * (`extractInviteCode`, which accepts a bare code or a shared https link) and
 * the deep-link parser (`parseInviteDeepLink`, hiroba://invite/<token> only) —
 * plus the e-mail one-time-code client (`sanitizeCode`, `emailStart`,
 * `emailVerify`).
 *
 * Run via `npm test` (compiled first by tsc into .test-build/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_LENGTH,
  CodeRejectedError,
  CodeThrottledError,
  InviteRejectedError,
  clearSession,
  emailStart,
  emailVerify,
  extractInviteCode,
  loadSession,
  parseInviteDeepLink,
  sanitizeCode,
  saveSession,
} from "../.test-build/auth.js";

/** Swap in a stub `fetch` for one call, recording what it received. */
async function withFetch(handler, body) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler();
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

test("parseInviteDeepLink accepts hiroba://invite/<token>", () => {
  assert.equal(parseInviteDeepLink("hiroba://invite/aB3_x-9"), "aB3_x-9");
  assert.equal(parseInviteDeepLink(" hiroba://invite/aB3_x-9/ "), "aB3_x-9");
});

test("parseInviteDeepLink rejects everything else", () => {
  assert.equal(parseInviteDeepLink("hiroba://invite/"), null);
  assert.equal(parseInviteDeepLink("hiroba://other/aB3"), null);
  assert.equal(parseInviteDeepLink("https://auth.example.com/invite/aB3"), null);
  assert.equal(parseInviteDeepLink("hiroba://invite/bad token"), null);
  assert.equal(parseInviteDeepLink("hiroba://invite/a?x=1"), null);
  assert.equal(parseInviteDeepLink(`hiroba://invite/${"a".repeat(129)}`), null);
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

test("emailVerify returns a session, and passes the invite through", async () => {
  // Payload of a real session JWT: {"sub":"email:aoi@example.com","exp":9999999999}
  const claims = Buffer.from(
    JSON.stringify({ sub: "email:aoi@example.com", exp: 9999999999 }),
  ).toString("base64url");
  const token = `h.${claims}.s`;
  const { result, calls } = await withFetch(
    () => jsonResponse(200, { token, refresh_token: "r1" }),
    () => emailVerify("https://auth.example.com", "aoi@example.com", "012345", "inv-1"),
  );
  assert.equal(calls[0].url, "https://auth.example.com/email/verify");
  assert.deepEqual(calls[0].body, {
    email: "aoi@example.com",
    code: "012345",
    invite: "inv-1",
  });
  assert.equal(result.kind, "session");
  assert.equal(result.session.refreshToken, "r1");
  assert.equal(result.session.claims.sub, "email:aoi@example.com");
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

  // A refused *invite* is its own thing: the code was never spent, so telling
  // the user to fetch a new one would be wrong.
  const { result: badInvite } = await withFetch(
    () => new Response("invite invalid, used, or expired", { status: 409 }),
    () =>
      emailVerify("https://auth.example.com", "aoi@example.com", "012345", "dead").catch((e) => e),
  );
  assert.ok(badInvite instanceof InviteRejectedError);

  const { result: malformed } = await withFetch(
    () => jsonResponse(200, { token: "not-a-jwt", refresh_token: "r1" }),
    () => emailVerify("https://auth.example.com", "aoi@example.com", "012345").catch((e) => e),
  );
  assert.match(malformed.message, /malformed token/);
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
    await clearSession();
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

test("a sign-out queued behind an in-flight save still wins", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const tauri = withTauri({ gate });
  try {
    const saving = saveSession({ token: jwt(3600), claims: { exp: 0 }, refreshToken: "r1" });
    const clearing = clearSession(); // user hits Sign out mid-write
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
