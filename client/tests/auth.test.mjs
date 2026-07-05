/**
 * Tests for the invite-code normalizers in src/auth.ts: the join-form field
 * (`extractInviteCode`, which accepts a bare code or a shared https link) and
 * the deep-link parser (`parseInviteDeepLink`, hiroba://invite/<token> only).
 *
 * Run via `npm test` (compiled first by tsc into .test-build/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractInviteCode, parseInviteDeepLink } from "../.test-build/auth.js";

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
