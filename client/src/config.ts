/**
 * config.ts — Runtime client configuration that is *not* part of the wire
 * protocol.
 *
 * The one thing that lives here today is the **ICE server list** used for
 * WebRTC. Per the requirements (NFR-07) the *hosted* build MUST ship
 * a TURN server so connections succeed behind symmetric NAT / corporate
 * firewalls, while *self-host* defaults to public STUN and only adds TURN if an
 * operator needs it. Crucially, TURN credentials are delivered to the client
 * **out of band** (the desktop app's config), never across the WebSocket — so
 * the resolution of which ICE servers to use belongs here, not in protocol.ts.
 *
 * Resolution order (first match wins):
 *   1. `window.__HIROBA_CONFIG__.iceServers` — injected at runtime by the
 *      desktop shell (Tauri) or a `<script>` in index.html for a hosted deploy.
 *      This is the operator override: a self-host operator hard-wires their own
 *      coturn relay, or a packaged build pins a fixed list.
 *   2. The server's `GET /ice` endpoint — fetched out-of-band over HTTP (never
 *      the signaling WebSocket). A hosted/self-host server hands back STUN plus
 *      TURN entries carrying freshly minted **short-lived** credentials
 *      (`server/src/ice.rs`). This is how the hosted profile delivers TURN
 *      without baking long-lived secrets into the client (NFR-07, §7.4).
 *   3. Public STUN (`stun:stun.l.google.com:19302`) — the self-host default if
 *      no override is set and the server reports no TURN.
 *
 * The injected value is a JSON array of standard `RTCIceServer` objects, e.g.:
 *   [
 *     { "urls": "stun:stun.l.google.com:19302" },
 *     { "urls": "turn:turn.example.com:3478",
 *       "username": "u", "credential": "p" }
 *   ]
 */

/** The self-host default: public STUN, enough for most home/office networks. */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/** Shape of the optional runtime config object the shell may inject. */
interface HirobaRuntimeConfig {
  iceServers?: RTCIceServer[];
}

declare global {
  interface Window {
    __HIROBA_CONFIG__?: HirobaRuntimeConfig;
  }
}

/**
 * Resolve the ICE server list synchronously from the operator override only.
 * Falls back to public STUN if nothing is injected, and is defensive about
 * malformed input (a bad override must never leave the client with no STUN at
 * all). Used as the immediate, offline-safe answer; prefer
 * {@link resolveIceServers} when a server URL is available so the server's TURN
 * relay (with short-lived credentials) can be picked up.
 */
export function getIceServers(): RTCIceServer[] {
  // 1. Runtime injection by the desktop shell / hosted deploy (operator wins).
  const injected = globalThis.window?.__HIROBA_CONFIG__?.iceServers;
  if (isValidIceServerList(injected)) return injected;

  // 2. Self-host default.
  return DEFAULT_ICE_SERVERS;
}

/**
 * Resolve the ICE server list for a session, consulting (in order) the operator
 * override, then the server's `GET /ice` endpoint, then public STUN. The fetch
 * is best-effort: any network/parse failure or malformed response falls through
 * to STUN so a connection is never stranded (mirrors {@link getIceServers}).
 *
 * `serverWsUrl` is the same `ws(s)://host/ws` the client connects to; the ICE
 * endpoint is derived from it ({@link iceEndpointFromWs}).
 */
export async function resolveIceServers(
  serverWsUrl?: string,
  token?: string,
  signal?: AbortSignal,
): Promise<RTCIceServer[]> {
  // 1. Operator override wins outright — don't even hit the network.
  const injected = globalThis.window?.__HIROBA_CONFIG__?.iceServers;
  if (isValidIceServerList(injected)) return injected;

  // 2. Ask the server (out-of-band over HTTP, never the WebSocket).
  if (serverWsUrl) {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 12_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(iceEndpointFromWs(serverWsUrl), { headers, signal: controller.signal });
      if (res.ok) {
        const body: unknown = await res.json();
        const servers = (body as { iceServers?: unknown } | null)?.iceServers;
        if (isValidIceServerList(servers)) return servers;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      // Network/CORS/parse failure — fall through to STUN.
    } finally {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
    }
  }

  // 3. Self-host default.
  return DEFAULT_ICE_SERVERS;
}

/**
 * Map a signaling WebSocket URL to its sibling `/ice` HTTP(S) endpoint:
 * `ws://host:port/ws` → `http://host:port/ice`, `wss://…` → `https://…`.
 * Throws if `wsUrl` is not a parseable URL.
 */
export function iceEndpointFromWs(wsUrl: string): string {
  const u = new URL(wsUrl);
  const httpProto = u.protocol === "wss:" ? "https:" : "http:";
  return `${httpProto}//${u.host}/ice`;
}

/**
 * Validate an injected ICE server list strictly enough that everything that
 * passes is safe to hand to `new RTCPeerConnection(...)`. A non-empty array
 * whose every entry has a `urls` value that is a usable ICE URL — or a non-empty
 * array of usable ICE URLs. Anything else (empty `urls`, non-string entries, a
 * bad scheme like `https:`) is rejected so the caller falls back to STUN rather
 * than letting the RTCPeerConnection constructor throw and disable voice.
 */
function isValidIceServerList(v: unknown): v is RTCIceServer[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        "urls" in s &&
        isValidIceUrls((s as RTCIceServer).urls),
    )
  );
}

/** ICE URLs must use a STUN/TURN scheme; reject empties and bad schemes. */
function isValidIceUrls(urls: unknown): boolean {
  if (typeof urls === "string") return isValidIceUrl(urls);
  if (Array.isArray(urls)) return urls.length > 0 && urls.every(isValidIceUrl);
  return false;
}

/** A single ICE URL: a non-empty string with a `stun:`/`stuns:`/`turn:`/`turns:` scheme. */
function isValidIceUrl(u: unknown): boolean {
  return typeof u === "string" && /^stuns?:|^turns?:/i.test(u.trim());
}
