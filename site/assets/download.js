/* Hiroba landing site — OS-aware direct download links.
   Fetches the latest GitHub Release assets once, then wires primary CTAs and
   optional "other platform" links. Swap DOWNLOAD_BASE when mirroring to CDN. */
(() => {
  'use strict';

  const REPO = 'ludo-technologies/hiroba';
  const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
  // Mirror later: e.g. 'https://download.hiroba.app/latest'
  const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/latest/download`;

  const PICKERS = [
    { id: 'mac-arm', labelKey: 'downloadMacArm', match: (name) => /aarch64\.dmg$/i.test(name) },
    {
      id: 'mac-intel',
      labelKey: 'downloadMacIntel',
      match: (name) => /_x64\.dmg$/i.test(name),
    },
    {
      id: 'mac-universal',
      labelKey: 'downloadMacUniversal',
      match: (name) => /universal\.dmg$/i.test(name),
    },
    {
      id: 'win',
      labelKey: 'downloadWin',
      match: (name) => /\.msi$/i.test(name) || /-setup\.exe$/i.test(name),
    },
    { id: 'linux', labelKey: 'downloadLinux', match: (name) => /\.AppImage$/i.test(name) },
  ];

  const PRIMARY_LABEL = {
    mac: 'downloadCtaMac',
    win: 'downloadCtaWin',
    linux: 'downloadCtaLinux',
    fallback: 'invitedCta',
  };

  function t(key) {
    return window.HirobaSiteI18n?.t?.[key] ?? null;
  }

  function txt(key, fallback) {
    return t(key) ?? fallback;
  }

  function detectOsFamily() {
    const ua = navigator.userAgent || '';
    const platform =
      navigator.userAgentData?.platform ||
      navigator.platform ||
      '';
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'win';
    if (/Linux/i.test(platform) && !/Android/i.test(ua)) return 'linux';
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'mac';
    return 'other';
  }

  function detectMacArchFromWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      if (!dbg) return null;
      const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
      if (/Apple M\d/i.test(renderer)) return 'arm';
      if (/Intel|AMD Radeon/i.test(renderer)) return 'intel';
    } catch {
      /* ignore */
    }
    return null;
  }

  async function detectMacArch() {
    if (navigator.userAgentData?.getHighEntropyValues) {
      try {
        const { architecture } = await navigator.userAgentData.getHighEntropyValues([
          'architecture',
        ]);
        if (architecture === 'arm') return 'arm';
        if (architecture === 'x86') return 'intel';
      } catch {
        /* fall through */
      }
    }
    const fromWebGl = detectMacArchFromWebGL();
    if (fromWebGl) return fromWebGl;
    return 'unknown';
  }

  function assetUrl(name) {
    return `${DOWNLOAD_BASE}/${encodeURIComponent(name)}`;
  }

  function classifyAssets(assets) {
    const picks = new Map();
    for (const asset of assets) {
      const name = asset.name || '';
      for (const rule of PICKERS) {
        if (picks.has(rule.id)) continue;
        if (rule.match(name)) {
          picks.set(rule.id, { ...rule, name, url: assetUrl(name) });
        }
      }
    }
    return picks;
  }

  function pickPrimary(picks, osFamily, macArch) {
    if (osFamily === 'mac') {
      const hasArm = picks.has('mac-arm');
      const hasIntel = picks.has('mac-intel');
      if (picks.has('mac-universal')) return picks.get('mac-universal');
      if (macArch === 'intel' && hasIntel) return picks.get('mac-intel');
      if (macArch === 'arm' && hasArm) return picks.get('mac-arm');
      // Unknown arch with split installers: never guess — surface both links instead.
      if (macArch === 'unknown' && hasArm && hasIntel) return null;
      if (hasArm) return picks.get('mac-arm');
      if (hasIntel) return picks.get('mac-intel');
      return null;
    }
    if (osFamily === 'win' && picks.has('win')) return picks.get('win');
    if (osFamily === 'linux' && picks.has('linux')) return picks.get('linux');
    return picks.values().next().value ?? null;
  }

  function primaryLabelKey(osFamily) {
    if (osFamily === 'mac') return PRIMARY_LABEL.mac;
    if (osFamily === 'win') return PRIMARY_LABEL.win;
    if (osFamily === 'linux') return PRIMARY_LABEL.linux;
    return PRIMARY_LABEL.fallback;
  }

  async function fetchLatestAssets() {
    const cacheKey = 'hiroba:latest-release-assets';
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      /* ignore */
    }

    const res = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return [];
    const release = await res.json();
    const assets = (release.assets || [])
      .filter((a) => a?.name && a.state !== 'placeholder')
      .map((a) => ({ name: a.name, url: assetUrl(a.name) }));

    try {
      sessionStorage.setItem(cacheKey, JSON.stringify(assets));
    } catch {
      /* ignore */
    }
    return assets;
  }

  function isMacArchAmbiguous(osFamily, macArch, picks) {
    return (
      osFamily === 'mac' &&
      macArch === 'unknown' &&
      picks.has('mac-arm') &&
      picks.has('mac-intel') &&
      !picks.has('mac-universal')
    );
  }

  function wirePrimary(els, pick, osFamily, macArch, picks) {
    const ambiguous = isMacArchAmbiguous(osFamily, macArch, picks);
    const label = ambiguous
      ? txt('downloadChooseMac', 'Choose your Mac version below')
      : txt(primaryLabelKey(osFamily), 'Download the app');
    for (const el of els) {
      if (ambiguous) {
        el.removeAttribute('href');
        el.setAttribute('aria-disabled', 'true');
        el.classList.add('is-disabled');
        el.textContent = label;
        continue;
      }
      // No matching asset for this OS: keep the static fallback link
      // (GitHub releases page) untouched.
      if (!pick) continue;
      el.href = pick.url;
      el.removeAttribute('target');
      el.removeAttribute('rel');
      el.removeAttribute('aria-disabled');
      el.classList.remove('is-disabled');
      if (el.dataset.i18n) el.textContent = label;
      else el.textContent = label;
    }
  }

  function wireFooter(els, pick) {
    for (const el of els) {
      // Keep the static fallback href when there is nothing better to offer.
      if (!pick) continue;
      el.href = pick.url;
      el.removeAttribute('target');
      el.removeAttribute('rel');
      el.removeAttribute('aria-disabled');
    }
  }

  function wireMore(container, picks, primary, osFamily, macArch) {
    if (!container) return;
    let items = [...picks.values()].filter((p) => p.url !== primary?.url);
    if (isMacArchAmbiguous(osFamily, macArch, picks)) {
      items = [picks.get('mac-arm'), picks.get('mac-intel')].filter(Boolean);
    }
    if (!items.length) {
      container.hidden = true;
      return;
    }

    const sep = txt('downloadMoreSep', ' · ');
    container.replaceChildren(
      ...items.flatMap((item, i) => {
        const nodes = [];
        if (i > 0) nodes.push(document.createTextNode(sep));
        const a = document.createElement('a');
        a.href = item.url;
        a.textContent = txt(item.labelKey, item.name);
        nodes.push(a);
        return nodes;
      })
    );
    container.hidden = false;
  }

  async function init() {
    const primaryEls = document.querySelectorAll('[data-download="primary"]');
    const footerEls = document.querySelectorAll('[data-download="footer"]');
    const moreEl = document.querySelector('[data-download-more]');
    if (!primaryEls.length && !footerEls.length) return;

    const osFamily = detectOsFamily();
    const macArch = osFamily === 'mac' ? await detectMacArch() : null;
    const assets = await fetchLatestAssets();
    const picks = classifyAssets(assets);
    // API failure or rate limit: leave the static fallback links as-is.
    if (!picks.size) return;
    const primary = pickPrimary(picks, osFamily, macArch);
    const macAmbiguous = isMacArchAmbiguous(osFamily, macArch, picks);
    const footerPick = macAmbiguous ? null : (primary ?? picks.values().next().value ?? null);

    wirePrimary(primaryEls, primary, osFamily, macArch, picks);
    wireFooter(footerEls, footerPick);
    wireMore(moreEl, picks, primary, osFamily, macArch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();