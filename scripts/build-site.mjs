#!/usr/bin/env node
/**
 * Build the Hiroba marketing site into site-dist/.
 *
 * - Copies site/ and stamps {{ASSET_VERSION}} in HTML with a deploy-time id
 *   (git short SHA by default, or SITE_ASSET_VERSION / CF_PAGES_COMMIT_SHA).
 * - Fetches the latest GitHub Release and injects a download manifest into HTML
 *   so download buttons point at the correct .dmg/.msi/.AppImage immediately.
 *
 * Set HIROBA_SKIP_RELEASE_FETCH=1 to build offline (download.js falls back to
 * the GitHub Releases page).
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { FALLBACK_URL, fetchReleaseManifest } from './download-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'site');
const OUT = join(ROOT, 'site-dist');
const PLACEHOLDER = '{{ASSET_VERSION}}';
const MANIFEST_MARKER = '<!-- HIROBA_DOWNLOAD_MANIFEST -->';

function resolveVersion() {
  if (process.env.SITE_ASSET_VERSION) return process.env.SITE_ASSET_VERSION;
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else cpSync(from, to);
  }
}

function manifestScript(manifest) {
  const json = JSON.stringify(manifest).replace(/</g, '\\u003c');
  return `<script type="application/json" id="hiroba-download-manifest">${json}</script>`;
}

function stampHtml(dir, version, manifestScriptHtml) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      stampHtml(path, version, manifestScriptHtml);
      continue;
    }
    if (!name.endsWith('.html')) continue;
    let html = readFileSync(path, 'utf8');
    if (html.includes(PLACEHOLDER)) {
      html = html.replaceAll(PLACEHOLDER, version);
    }
    if (html.includes(MANIFEST_MARKER)) {
      html = html.replace(MANIFEST_MARKER, manifestScriptHtml);
    }
    writeFileSync(path, html);
  }
}

async function resolveManifest() {
  if (process.env.HIROBA_SKIP_RELEASE_FETCH === '1') {
    console.warn('Skipping GitHub Releases fetch (HIROBA_SKIP_RELEASE_FETCH=1)');
    return { tag_name: '', fallback: FALLBACK_URL, picks: {} };
  }
  try {
    const manifest = await fetchReleaseManifest();
    if (!Object.keys(manifest.picks).length) {
      console.warn('Latest release has no matching download assets; using fallback links');
    }
    return manifest;
  } catch (err) {
    console.warn(`GitHub Releases fetch failed: ${err.message}`);
    console.warn('Download buttons will fall back to the GitHub Releases page');
    return { tag_name: '', fallback: FALLBACK_URL, picks: {} };
  }
}

const version = resolveVersion();

rmSync(OUT, { recursive: true, force: true });
copyDir(SRC, OUT);

const manifest = await resolveManifest();
writeFileSync(join(OUT, 'assets', 'download-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
stampHtml(OUT, version, manifestScript(manifest));

const pickCount = Object.keys(manifest.picks).length;
const tag = manifest.tag_name || 'none';
console.log(`Built site → site-dist (asset version: ${version}, release: ${tag}, downloads: ${pickCount})`);