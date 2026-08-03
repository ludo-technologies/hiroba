/**
 * updater.ts — Desktop auto-update (Tauri updater plugin).
 *
 * Checks the release feed (endpoints baked in via tauri.conf.json) shortly
 * after launch and every few hours while the app stays open — an office app
 * routinely runs for days. When a newer signed build exists, ui.ts shows a
 * calm banner; one click downloads, installs, and relaunches.
 *
 * The check keeps running on its interval even after the banner has been
 * shown. It costs one small request, and it is what tells us the install is
 * still alive — an app that stopped checking in is indistinguishable from one
 * that was deleted.
 *
 * Because sessions outlive releases, the banner must track the feed: a later
 * check that finds a *different* version replaces the offer (the text and the
 * update it installs together), otherwise a days-old banner silently installs
 * a days-old build and the user climbs one release per relaunch. Only an
 * unchanged version is suppressed — a user who ignored the banner should not
 * be nagged every four hours about the same release, but a genuinely newer
 * one is new information and may reappear.
 *
 * Failures never interrupt the user: a failed check only logs (offline is
 * normal), a failed install re-arms the banner with a toast. Runs only under
 * Tauri — a plain-browser session has nothing to update.
 */

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "./auth.js";
import type { UIManager } from "./ui.js";

/** Startup grace so the join screen paints before we touch the network. */
const FIRST_CHECK_DELAY_MS = 5_000;

/** Re-check cadence while the app stays open. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Version the banner currently offers (suppresses same-version re-offers). */
let offeredVersion: string | null = null;

/** The update behind the banner. Kept so a superseding release can free it —
 *  `check()` hands back a Rust-side Resource; dropping one without `close()`
 *  leaks a handle. */
let pending: Update | null = null;

/** True from install click until relaunch (or failure); a mid-download check
 *  must not yank the banner — or the update being installed — out from under
 *  the user. */
let installing = false;

/** Begin periodic update checks. Call once at startup; no-op outside Tauri. */
export function startUpdateChecks(ui: UIManager): void {
  if (!isTauri()) return;
  window.setTimeout(() => void checkOnce(ui), FIRST_CHECK_DELAY_MS);
  window.setInterval(() => void checkOnce(ui), CHECK_INTERVAL_MS);
}

async function checkOnce(ui: UIManager): Promise<void> {
  let update;
  try {
    update = await check();
  } catch (e) {
    // Expected offline / on Linux packages without updater support; stay quiet.
    console.warn("[updater] check failed:", e);
    return;
  }
  if (!update) return;

  // The release we already offered, or one landing mid-install: drop the
  // duplicate handle and leave the banner alone.
  if (installing || update.version === offeredVersion) {
    await update.close().catch(() => {});
    return;
  }

  // First offer of the session, or a newer release superseding the banner.
  // The resource swaps with the text, so the banner installs what it names.
  await pending?.close().catch(() => {});
  pending = update;
  offeredVersion = update.version;
  ui.showUpdateBanner(update.version, () => void install(ui, update));
}

async function install(ui: UIManager, update: Update): Promise<void> {
  installing = true;
  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.error("[updater] install failed:", e);
    installing = false;
    ui.updateBannerFailed();
  }
}
