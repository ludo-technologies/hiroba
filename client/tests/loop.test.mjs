/**
 * Regression tests for the demand-driven loop decisions (src/loop.ts).
 *
 * Guards bug #1: when you are solo and LIVE (unmuted), the loop must stay awake
 * so it keeps polling your mic and animating your own speaking ring. The
 * original bug let the loop sleep — no connections, momentarily silent — so the
 * self ring never animated.
 *
 * Run via `npm test` (compiles src → .test-build first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldDraw, shouldKeepAwake } from "../.test-build/loop.js";

// Order: (moving, audioActive, wasAnimating, hasConnections, muted)

test("idle resting state (muted, still, silent, alone) sleeps — the ~0% CPU goal", () => {
  assert.equal(shouldKeepAwake(false, false, false, false, true), false);
});

test("BUG #1: live (unmuted) keeps the loop awake even when solo and silent", () => {
  // No movement, no voice yet, no animation, no peers — but mic is live.
  assert.equal(shouldKeepAwake(false, false, false, false, /* muted */ false), true);
});

test("a connected peer keeps the loop awake (to notice remote speech)", () => {
  assert.equal(shouldKeepAwake(false, false, false, /* hasConnections */ true, true), true);
});

test("movement, live voice, and in-flight animation each keep the loop awake", () => {
  assert.equal(shouldKeepAwake(true, false, false, false, true), true); // moving
  assert.equal(shouldKeepAwake(false, true, false, false, true), true); // audioActive
  assert.equal(shouldKeepAwake(false, false, true, false, true), true); // wasAnimating
});

test("shouldDraw repaints only on a visual change, not merely because live", () => {
  // Live + still + silent + nothing dirty ⇒ poll, but do NOT repaint.
  assert.equal(shouldDraw(false, false, false, false), false);
  assert.equal(shouldDraw(true, false, false, false), true); // moving
  assert.equal(shouldDraw(false, true, false, false), true); // live voice
  assert.equal(shouldDraw(false, false, true, false), true); // animation settling
  assert.equal(shouldDraw(false, false, false, true), true); // one-shot dirty event
});
