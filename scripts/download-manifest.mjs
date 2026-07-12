/**
 * Build-time GitHub Release asset picker for the Hiroba marketing site.
 * Shared by scripts/build-site.mjs; runtime wiring lives in site/assets/download.js.
 */

export const REPO = 'ludo-technologies/hiroba';
export const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

/** @type {Array<{ id: string, match: (name: string) => boolean }>} */
// Landing CTAs only surface macOS + Windows. Linux artifacts still ship on
// GitHub Releases for power users; they are not linked from the marketing site.
export const PICKERS = [
  { id: 'mac-arm', match: (name) => /aarch64\.dmg$/i.test(name) },
  { id: 'mac-intel', match: (name) => /_x64\.dmg$/i.test(name) },
  { id: 'mac-universal', match: (name) => /universal\.dmg$/i.test(name) },
  // Prefer the NSIS installer when both .exe and .msi are present.
  { id: 'win', match: (name) => /-setup\.exe$/i.test(name) || /\.msi$/i.test(name) },
];

/**
 * @param {Array<{ name?: string, browser_download_url?: string, state?: string }>} assets
 * @returns {Record<string, { name: string, url: string }>}
 */
export function classifyReleaseAssets(assets) {
  /** @type {Record<string, { name: string, url: string }>} */
  const picks = {};
  for (const asset of assets) {
    const name = asset.name || '';
    if (!name || asset.state === 'placeholder' || !asset.browser_download_url) continue;
    for (const rule of PICKERS) {
      if (picks[rule.id]) continue;
      if (rule.match(name)) {
        picks[rule.id] = { name, url: asset.browser_download_url };
      }
    }
  }
  return picks;
}

/**
 * @returns {Promise<{ tag_name: string, fallback: string, picks: Record<string, { name: string, url: string }> } | null>}
 */
export async function fetchReleaseManifest() {
  const res = await fetch(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hiroba-site-build',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub Releases API ${res.status} ${res.statusText}`);
  }
  const release = await res.json();
  const picks = classifyReleaseAssets(release.assets || []);
  return {
    tag_name: release.tag_name || '',
    fallback: FALLBACK_URL,
    picks,
  };
}