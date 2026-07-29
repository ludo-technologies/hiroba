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
  emailStart,
  emailVerify,
  extractInviteCode,
  parseInviteDeepLink,
  sanitizeCode,
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
