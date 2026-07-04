/**
 * updater.ts — Desktop auto-update (Tauri updater plugin).
 *
 * Checks the release feed (`latest.json` on GitHub Releases, endpoint baked in
 * via tauri.conf.json) shortly after launch and every few hours while the app
 * stays open — an office app routinely runs for days. When a newer signed
 * build exists, ui.ts shows a calm banner; one click downloads, installs, and
 * relaunches.
 *
 * Failures never interrupt the user: a failed check only logs (offline is
 * normal), a failed install re-arms the banner with a toast. Runs only under
 * Tauri — a plain-browser session has nothing to update.
 */

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "./auth.js";
import type { UIManager } from "./ui.js";

/** Startup grace so the join screen paints before we touch the network. */
const FIRST_CHECK_DELAY_MS = 5_000;

/** Re-check cadence while the app stays open. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Latched once a banner has been offered; the next launch offers again.
 *  Keeps a dismissed banner from re-appearing every interval. */
let offered = false;

/** Begin periodic update checks. Call once at startup; no-op outside Tauri. */
export function startUpdateChecks(ui: UIManager): void {
  if (!isTauri()) return;
  window.setTimeout(() => void checkOnce(ui), FIRST_CHECK_DELAY_MS);
  window.setInterval(() => void checkOnce(ui), CHECK_INTERVAL_MS);
}

async function checkOnce(ui: UIManager): Promise<void> {
  if (offered) return;
  let update;
  try {
    update = await check();
  } catch (e) {
    // Expected offline / on Linux packages without updater support; stay quiet.
    console.warn("[updater] check failed:", e);
    return;
  }
  if (!update) return;
  offered = true;
  ui.showUpdateBanner(update.version, () => {
    void (async () => {
      try {
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        console.error("[updater] install failed:", e);
        ui.updateBannerFailed();
      }
    })();
  });
}
