/**
 * net.ts — WebSocket client for the Hiroba wire protocol.
 *
 * Design goals:
 *  - Thin, typed wrapper: all message parsing happens here so callers work
 *    with strongly-typed ServerMsg objects, never raw strings.
 *  - EventTarget-based dispatch so subscribers can be added/removed freely.
 *  - Clean error / close surface: the UI layer registers listeners and
 *    decides what to show; this module does not touch the DOM.
 *  - No automatic reconnect in MVP (per spec), but onclose/onerror are
 *    forwarded clearly so the UI can offer a manual rejoin.
 */

import type { ClientMsg, ServerMsg } from "./protocol.js";

// ---------------------------------------------------------------------------
// Custom event types emitted on the EventTarget
// ---------------------------------------------------------------------------

/** Fired for every well-formed server message. */
export type MessageEvent<T extends ServerMsg = ServerMsg> = CustomEvent<T>;

/** Fired when the socket closes (normal or abnormal). */
export type CloseEvent = CustomEvent<{ code: number; reason: string; wasClean: boolean }>;

/** Fired when the socket emits an error (details are browser-opaque). */
export type ErrorEvent = CustomEvent<void>;

// ---------------------------------------------------------------------------
// HirobaNet
// ---------------------------------------------------------------------------

/**
 * Manages a single WebSocket connection to the Hiroba signaling server.
 *
 * Usage:
 *   const net = new HirobaNet();
 *   net.on("welcome", (e) => { ... e.detail ... });
 *   await net.connect("ws://127.0.0.1:8787/ws");
 *   net.send({ t: "hello", name: "Aoi", color: "#4f9dde" });
 */
export class HirobaNet extends EventTarget {
  private ws: WebSocket | null = null;

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  /**
   * Open a WebSocket connection to `url`.
   *
   * Resolves as soon as the socket is open (so the caller can immediately
   * send `hello`). Rejects if the connection fails to open.
   */
  connect(url: string, signal?: AbortSignal, timeoutMs = 12_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        fn();
      };
      const abort = () => finish(() => {
        ws.close();
        reject(new DOMException("Connection cancelled", "AbortError"));
      });
      const timer = window.setTimeout(() => finish(() => {
        ws.close();
        reject(new Error("connection_timeout"));
      }), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();

      ws.addEventListener("open", () => finish(resolve), { once: true });

      ws.addEventListener(
        "error",
        () => {
          // The browser gives no detail on WS error events for security
          // reasons. Surface a typed event so the UI can react.
          this.dispatchEvent(new CustomEvent("neterror"));
          finish(() => reject(new Error("WebSocket connection failed")));
        },
        { once: true },
      );

      ws.addEventListener("message", (raw) => this._handleMessage(raw));
      ws.addEventListener("close", (ev) => this._handleClose(ev));
    });
  }

  /**
   * Close the socket gracefully. Idempotent: safe to call when already
   * closed. Does NOT fire the `close` custom event — that is reserved for
   * server-initiated or unexpected closes.
   */
  close(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000, "leaving");
    }
    this.ws = null;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Serialize and send a ClientMsg. No-op if the socket is not open.
   * Callers should not need to check readyState; the only window where
   * sends could be dropped is between connect() and the hello handshake,
   * which is all orchestrated by main.ts.
   */
  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // -------------------------------------------------------------------------
  // Convenience typed listener helpers
  // -------------------------------------------------------------------------

  /**
   * Register a handler for a specific server message type.
   * Returns `this` for chaining.
   *
   * Example:
   *   net.on("welcome", (e) => initSpace(e.detail));
   *   net.on("state",   (e) => updatePositions(e.detail.peers));
   */
  on<T extends ServerMsg["t"]>(
    type: T,
    handler: (e: CustomEvent<Extract<ServerMsg, { t: T }>>) => void,
    options?: AddEventListenerOptions,
  ): this {
    // The cast is safe because _handleMessage dispatches CustomEvent<ServerMsg>
    // keyed by msg.t, so type `T` events always carry `Extract<ServerMsg, {t:T}>`.
    this.addEventListener(
      type,
      handler as EventListenerOrEventListenerObject,
      options,
    );
    return this;
  }

  /** Register a handler for socket close events. */
  onClose(
    handler: (e: CustomEvent<{ code: number; reason: string; wasClean: boolean }>) => void,
  ): this {
    this.addEventListener("close", handler as EventListenerOrEventListenerObject);
    return this;
  }

  /** Register a handler for socket error events. */
  onError(handler: (e: CustomEvent<void>) => void): this {
    this.addEventListener("neterror", handler as EventListenerOrEventListenerObject);
    return this;
  }

  // -------------------------------------------------------------------------
  // Internal handlers
  // -------------------------------------------------------------------------

  private _handleMessage(raw: globalThis.MessageEvent): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw.data as string) as ServerMsg;
    } catch {
      // Malformed JSON from the server — ignore per forward-compat rule.
      console.warn("[net] Received non-JSON frame; ignoring.");
      return;
    }

    if (typeof msg.t !== "string") {
      console.warn("[net] Message missing `t` field; ignoring.", msg);
      return;
    }

    // Dispatch a CustomEvent keyed by the message type so consumers can
    // listen with net.on("welcome", ...) rather than filtering a generic event.
    this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
  }

  private _handleClose(ev: globalThis.CloseEvent): void {
    this.ws = null;
    this.dispatchEvent(
      new CustomEvent("close", {
        detail: { code: ev.code, reason: ev.reason, wasClean: ev.wasClean },
      }),
    );
  }
}
