/**
 * Bulletin-board geometry (src/board.ts): the board hangs inside the room.
 *
 * Run via `npm test` (compiles src → .test-build first).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardGeometry } from "../.test-build/board.js";

// The server's descriptors (server/src/protocol.rs).
const space = (kind, nearRadius) => ({
  id: kind, name: kind, kind, width: 800, height: 600,
  nearRadius, farRadius: nearRadius + 30, tickHz: 12, capacity: 5,
});
const SPACES = [space("lobby", 150), space("team", 1000)];

test("the board hangs inside the room", () => {
  for (const s of SPACES) {
    const g = boardGeometry(s);
    assert.ok(g.x >= 0 && g.x + g.w <= s.width && g.y >= 0 && g.y + g.h <= s.height);
  }
});
