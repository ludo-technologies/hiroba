#!/usr/bin/env node
/**
 * Build the Hiroba marketing site into site-dist/.
 *
 * Copies site/ and stamps {{ASSET_VERSION}} in HTML with a deploy-time id
 * (git short SHA by default, or SITE_ASSET_VERSION / CF_PAGES_COMMIT_SHA).
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'site');
const OUT = join(ROOT, 'site-dist');
const PLACEHOLDER = '{{ASSET_VERSION}}';

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

function stampHtml(dir, version) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      stampHtml(path, version);
      continue;
    }
    if (!name.endsWith('.html')) continue;
    const html = readFileSync(path, 'utf8');
    if (!html.includes(PLACEHOLDER)) continue;
    writeFileSync(path, html.replaceAll(PLACEHOLDER, version));
  }
}

const version = resolveVersion();

rmSync(OUT, { recursive: true, force: true });
copyDir(SRC, OUT);
stampHtml(OUT, version);

console.log(`Built site → site-dist (asset version: ${version})`);