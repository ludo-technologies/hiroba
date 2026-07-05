/**
 * deeplink.ts — hiroba:// deep links (Tauri deep-link plugin).
 *
 * The invite landing page's "open in app" button points at
 * `hiroba://invite/<token>`. Two delivery paths funnel into one callback:
 *
 *   - cold start: the OS launches the app with the URL; `getCurrent()`
 *     returns it once the webview is up.
 *   - already running: the deep-link plugin emits `deep-link://new-url`
 *     (`onOpenUrl`); on Windows/Linux the single-instance plugin forwards
 *     the second process's URL there first.
 *
 * Runs only under Tauri — a plain browser tab never receives scheme URLs.
 */

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { isTauri, parseInviteDeepLink } from "./auth.js";

/** Start listening; `onInvite` fires with the bare token for each invite link. */
export function startDeepLinkListener(onInvite: (code: string) => void): void {
  if (!isTauri()) return;
  const handle = (urls: string[] | null) => {
    for (const url of urls ?? []) {
      const code = parseInviteDeepLink(url);
      if (code) onInvite(code);
    }
  };
  // onOpenUrl never replays the launch URL, so both calls together see each
  // link exactly once.
  getCurrent().then(handle).catch((e) => console.warn("[deeplink] getCurrent failed:", e));
  onOpenUrl(handle).catch((e) => console.warn("[deeplink] listen failed:", e));
}
