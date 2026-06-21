/**
 * Tests for config.getIceServers() (src/config.ts) — the ICE/TURN resolution
 * seam (NFR-07). A hosted build injects TURN via
 * `window.__HIROBA_CONFIG__`; self-host falls back to public STUN. A malformed
 * override must never strand the client with no STUN at all.
 *
 * Run via `npm test` (compiled first by tsc into .test-build/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getIceServers,
  resolveIceServers,
  iceEndpointFromWs,
} from "../.test-build/config.js";

// getIceServers reads globalThis.window?.__HIROBA_CONFIG__. In Node there is no
// `window`, so we define one and reset it per case.
function withWindow(value, fn) {
  const had = "window" in globalThis;
  const prev = globalThis.window;
  globalThis.window = value;
  const restore = () => {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  };
  try {
    const result = fn();
    if (result && typeof result.finally === "function") return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

test("defaults to public STUN when nothing is injected", () => {
  withWindow(undefined, () => {
    const servers = getIceServers();
    assert.equal(servers.length, 1);
    assert.match(String(servers[0].urls), /^stun:/);
  });
});

test("uses an injected TURN list when present (hosted path)", () => {
  const turn = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:turn.example.com:3478", username: "u", credential: "p" },
  ];
  withWindow({ __HIROBA_CONFIG__: { iceServers: turn } }, () => {
    const servers = getIceServers();
    assert.equal(servers.length, 2);
    assert.equal(servers[1].urls, "turn:turn.example.com:3478");
    assert.equal(servers[1].credential, "p");
  });
});

test("ignores a malformed override and keeps STUN (never strands the client)", () => {
  const bads = [
    [], // empty list
    "nope", // not an array
    42,
    [{ no_urls: 1 }], // entry without urls
    null,
    [{ urls: "" }], // empty url string
    [{ urls: [] }], // empty urls array
    [{ urls: 123 }], // non-string urls
    [{ urls: [123, "turn:ok:3478"] }], // non-string entry in urls array
    [{ urls: "https://turn.example" }], // wrong scheme (would throw in RTCPeerConnection)
    [{ urls: "turn:ok:3478" }, { urls: "ftp://bad" }], // one good, one bad scheme
  ];
  for (const bad of bads) {
    withWindow({ __HIROBA_CONFIG__: { iceServers: bad } }, () => {
      const servers = getIceServers();
      assert.ok(servers.length >= 1, `must keep STUN for ${JSON.stringify(bad)}`);
      assert.match(String(servers[0].urls), /^stun:/);
    });
  }
});

test("accepts a urls array of valid STUN/TURN strings", () => {
  const list = [{ urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"] }];
  withWindow({ __HIROBA_CONFIG__: { iceServers: list } }, () => {
    const servers = getIceServers();
    assert.equal(servers.length, 1);
    assert.deepEqual(servers[0].urls, list[0].urls);
  });
});

// ── iceEndpointFromWs: derive the HTTP /ice URL from the WS URL ────────────

test("iceEndpointFromWs maps ws→http and wss→https, swapping /ws for /ice", () => {
  assert.equal(iceEndpointFromWs("ws://127.0.0.1:8787/ws"), "http://127.0.0.1:8787/ice");
  assert.equal(iceEndpointFromWs("wss://hiroba.example.com/ws"), "https://hiroba.example.com/ice");
  assert.equal(iceEndpointFromWs("wss://host:9000/ws"), "https://host:9000/ice");
});

// ── resolveIceServers: override → server /ice → STUN ───────────────────────

// Swap in a fake global fetch for the duration of fn(), then restore it.
async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test("resolveIceServers: operator override wins without hitting the network", async () => {
  const turn = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:override.example.com:3478", username: "u", credential: "p" },
  ];
  let fetched = false;
  await withFetch(
    async () => {
      fetched = true;
      return { ok: true, json: async () => ({ iceServers: [] }) };
    },
    () =>
      new Promise((resolve) => {
        withWindow({ __HIROBA_CONFIG__: { iceServers: turn } }, async () => {
          const servers = await resolveIceServers("ws://127.0.0.1:8787/ws");
          assert.equal(servers.length, 2);
          assert.equal(servers[1].urls, "turn:override.example.com:3478");
          assert.equal(fetched, false, "override must short-circuit the fetch");
          resolve();
        });
      }),
  );
});

test("resolveIceServers: uses the server's /ice TURN list when no override", async () => {
  const fromServer = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:turn.server.com:3478", username: "1781000000:hiroba", credential: "abc=" },
    ],
  };
  await withFetch(
    async (url, init) => {
      assert.equal(url, "http://127.0.0.1:8787/ice");
      assert.equal(init.headers.authorization, "Bearer test-token");
      return { ok: true, json: async () => fromServer };
    },
    async () => {
      const servers = await resolveIceServers("ws://127.0.0.1:8787/ws", "test-token");
      assert.equal(servers.length, 2);
      assert.equal(servers[1].credential, "abc=");
    },
  );
});

test("resolveIceServers: falls back to STUN when the fetch fails", async () => {
  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const servers = await resolveIceServers("ws://127.0.0.1:8787/ws");
      assert.equal(servers.length, 1);
      assert.match(String(servers[0].urls), /^stun:/);
    },
  );
});

test("resolveIceServers: falls back to STUN on a non-ok or malformed response", async () => {
  // Non-ok HTTP status.
  await withFetch(
    async () => ({ ok: false, json: async () => ({}) }),
    async () => {
      const servers = await resolveIceServers("ws://127.0.0.1:8787/ws");
      assert.match(String(servers[0].urls), /^stun:/);
    },
  );
  // 200 but a malformed iceServers payload.
  await withFetch(
    async () => ({ ok: true, json: async () => ({ iceServers: "nope" }) }),
    async () => {
      const servers = await resolveIceServers("ws://127.0.0.1:8787/ws");
      assert.equal(servers.length, 1);
      assert.match(String(servers[0].urls), /^stun:/);
    },
  );
});

test("resolveIceServers: with no server URL and no override, returns STUN", async () => {
  await withWindow(undefined, async () => {
    const servers = await resolveIceServers(undefined);
    assert.equal(servers.length, 1);
    assert.match(String(servers[0].urls), /^stun:/);
  });
});
