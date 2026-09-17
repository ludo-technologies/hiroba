/**
 * Bulletin-board geometry (src/board.ts): the open/close hysteresis, and that
 * the stand point is never somewhere the server spawns people.
 *
 * Run via `npm test` (compiles src → .test-build first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_CLOSE_R, BOARD_OPEN_R, boardGeometry, boardOpen } from "../.test-build/board.js";

// The server's descriptors (server/src/protocol.rs).
const space = (kind, nearRadius) => ({
  id: kind, name: kind, kind, width: 800, height: 600,
  nearRadius, farRadius: nearRadius + 30, tickHz: 12, capacity: 5,
});
const SPACES = [space("lobby", 150), space("team", 1000)];

test("the board opens on approach and only closes past the outer radius", () => {
  assert.equal(boardOpen(false, BOARD_OPEN_R + 1), false);
  assert.equal(boardOpen(false, BOARD_OPEN_R), true);
  assert.equal(boardOpen(true, BOARD_CLOSE_R), true);
  assert.equal(boardOpen(true, BOARD_CLOSE_R + 1), false);
});

test("the board and its stand point are inside the room, the reader clear of the board", () => {
  for (const s of SPACES) {
    const g = boardGeometry(s);
    assert.ok(g.x >= 0 && g.x + g.w <= s.width && g.y >= 0);
    assert.ok(g.standY > g.y + g.h && g.standY < s.height);
  }
});

test("nobody spawns within opening range of the board", () => {
  for (const s of SPACES) {
    const g = boardGeometry(s);
    // server/src/state.rs spawn_position: a spiral of at most this radius.
    const spawnR = Math.min(Math.min(s.width, s.height) * 0.4, s.nearRadius * 0.9);
    const fromCentre = Math.hypot(g.standX - s.width / 2, g.standY - s.height / 2);
    assert.ok(fromCentre > spawnR + BOARD_OPEN_R, `${s.kind}: ${fromCentre} vs ${spawnR}`);
  }
});
