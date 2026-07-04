/* Hiroba landing site — OS-aware direct download links.
   Reads a build-time manifest (injected by scripts/build-site.mjs) and wires
   primary CTAs without calling the GitHub API at runtime. */
(() => {
  'use strict';

  const PRIMARY_LABEL = {
    mac: 'downloadCtaMac',
    win: 'downloadCtaWin',
    linux: 'downloadCtaLinux',
    fallback: 'invitedCta',
  };

  const MORE_LABEL = {
    'mac-arm': 'downloadMacArm',
    'mac-intel': 'downloadMacIntel',
    'mac-universal': 'downloadMacUniversal',
    win: 'downloadWin',
    linux: 'downloadLinux',
  };

  function t(key) {
    return window.HirobaSiteI18n?.t?.[key] ?? null;
  }

  function txt(key, fallback) {
    return t(key) ?? fallback;
  }

  function readManifest() {
    const el = document.getElementById('hiroba-download-manifest');
    if (!el?.textContent) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
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

  function manifestPicks(manifest) {
    const picks = new Map();
    for (const [id, asset] of Object.entries(manifest?.picks ?? {})) {
      if (asset?.url) {
        picks.set(id, {
          id,
          name: asset.name,
          url: asset.url,
          labelKey: MORE_LABEL[id],
        });
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

  function isMacArchAmbiguous(osFamily, macArch, picks) {
    return (
      osFamily === 'mac' &&
      macArch === 'unknown' &&
      picks.has('mac-arm') &&
      picks.has('mac-intel') &&
      !picks.has('mac-universal')
    );
  }

  function setDownloadHref(el, url) {
    el.href = url;
    el.removeAttribute('target');
    el.removeAttribute('rel');
  }

  function wirePrimary(els, pick, osFamily, macArch, picks) {
    const ambiguous = isMacArchAmbiguous(osFamily, macArch, picks);
    const label = txt(primaryLabelKey(osFamily), 'Download the app');
    for (const el of els) {
      if (ambiguous) {
        el.hidden = true;
        continue;
      }
      if (!pick) continue;
      el.hidden = false;
      setDownloadHref(el, pick.url);
      if (el.childElementCount === 0) {
        el.textContent = label;
      } else {
        const labelEl = el.querySelector('[data-i18n]');
        if (labelEl && osFamily !== 'other') labelEl.textContent = label;
      }
    }
  }

  function wireFooter(els, pick) {
    for (const el of els) {
      if (!pick) continue;
      setDownloadHref(el, pick.url);
      el.removeAttribute('aria-disabled');
    }
  }

  function wireMore(container, picks, primary, osFamily, macArch) {
    if (!container) return;
    const choiceMode = isMacArchAmbiguous(osFamily, macArch, picks);
    let items = [...picks.values()].filter((p) => p.url !== primary?.url);
    if (choiceMode) {
      items = [picks.get('mac-arm'), picks.get('mac-intel')].filter(Boolean);
    }
    container.classList.toggle('is-choice', choiceMode);
    if (!items.length) {
      container.hidden = true;
      return;
    }

    const sep = txt('downloadMoreSep', ' · ');
    const nodes = [];
    if (choiceMode) {
      const note = document.createElement('span');
      note.className = 'dl-note';
      note.textContent = txt('downloadChooseMac', 'Choose your Mac version below');
      nodes.push(note);
    }
    items.forEach((item, i) => {
      if (!choiceMode && i > 0) nodes.push(document.createTextNode(sep));
      const a = document.createElement('a');
      a.href = item.url;
      if (choiceMode) a.className = 'btn btn-primary';
      a.textContent = txt(item.labelKey, item.name);
      nodes.push(a);
    });
    container.replaceChildren(...nodes);
    container.hidden = false;
  }

  async function init() {
    const manifest = readManifest();
    const primaryEls = document.querySelectorAll('[data-download="primary"]');
    const footerEls = document.querySelectorAll('[data-download="footer"]');
    const moreEl = document.querySelector('[data-download-more]');
    if (!primaryEls.length && !footerEls.length) return;

    const picks = manifestPicks(manifest);
    if (!picks.size) return;

    const osFamily = detectOsFamily();
    const macArch = osFamily === 'mac' ? await detectMacArch() : null;
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