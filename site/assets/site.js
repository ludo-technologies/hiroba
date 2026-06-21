/* Hiroba landing site — scroll reveals + the live hero demo.
   Vanilla JS, no dependencies. The demo pauses when offscreen (NFR-01 in spirit). */
(() => {
  'use strict';

  const { t } = window.HirobaSiteI18n ?? { t: {} };

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------- reveal */
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (reduced || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.18 }
    );
    revealEls.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------------- hero demo */
  const canvas = document.getElementById('hiroba-canvas');
  if (!canvas) return;
  const rosterEl = document.getElementById('demo-roster');
  const tabsEl = document.getElementById('demo-tabs');
  const ctx = canvas.getContext('2d');

  const SPACE_IDS = ['lobby', 'dev', 'design'];
  const spaceLabel = (id) => {
    if (id === 'lobby') return t.demoSpaceLobby ?? 'Lobby';
    if (id === 'dev') return t.demoSpaceDev ?? 'Dev';
    if (id === 'design') return t.demoSpaceDesign ?? 'Design';
    return id;
  };

  const NEAR = 130; // px: proximity radius for the voice link
  const PAD = 0.1; // normalized margin around the floor

  const members = [
    { id: 'self', color: '#d8552e', space: 'lobby', self: true },
    { id: 'ren', color: '#5a8f6a', space: 'lobby' },
    { id: 'yuu', color: '#34506b', space: 'dev' },
    { id: 'kan', color: '#c0913b', space: 'dev', call: true },
    { id: 'hina', color: '#8d6a9f', space: 'design', dnd: true },
    { id: 'miu', color: '#a99e8c', space: null, away: true },
  ];
  const memberName = (m) => {
    const key = `demoMember${m.id.charAt(0).toUpperCase()}${m.id.slice(1)}`;
    return t[key] ?? m.id;
  };
  // members who wander between spaces over time (self stays in the lobby)
  const movers = members.filter((m) => m.id === 'ren' || m.id === 'yuu');

  const rnd = (a, b) => a + Math.random() * (b - a);
  const place = (m) => {
    m.x = rnd(PAD, 1 - PAD);
    m.y = rnd(PAD + 0.05, 1 - PAD);
    m.tx = m.x;
    m.ty = m.y;
    m.dwell = rnd(0.5, 2.5);
  };
  members.forEach((m) => {
    place(m);
    m.alpha = 1;
    m.fade = 0; // -1 leaving, +1 entering, 0 settled
  });

  let view = 'lobby';

  // simple per-space furniture, in normalized floor coordinates
  const FURNITURE = {
    lobby: [
      { kind: 'rug', x: 0.5, y: 0.52, rx: 0.22, ry: 0.18 },
      { kind: 'plant', x: 0.08, y: 0.12 },
      { kind: 'plant', x: 0.92, y: 0.88 },
    ],
    dev: [
      { kind: 'desk', x: 0.3, y: 0.32, w: 0.24, h: 0.14 },
      { kind: 'desk', x: 0.68, y: 0.66, w: 0.24, h: 0.14 },
      { kind: 'plant', x: 0.9, y: 0.12 },
    ],
    design: [
      { kind: 'desk', x: 0.5, y: 0.48, w: 0.34, h: 0.18 },
      { kind: 'plant', x: 0.1, y: 0.85 },
    ],
  };

  /* ----- sidebar roster + tabs (DOM, driven by the same state) ----- */
  const statusOf = (m) => {
    if (m.away) return t.demoStatusAway ?? 'Away';
    if (m.dnd) return t.demoStatusDnd ?? 'DND';
    if (m.call) return t.demoStatusCall ?? 'On call';
    return m.space ? spaceLabel(m.space) : '';
  };
  const dotClass = (m) => {
    if (m.away) return 'dot away';
    if (m.dnd) return 'dot dnd';
    if (m.call) return 'dot call';
    return 'dot';
  };

  function renderRoster() {
    rosterEl.innerHTML = members
      .map(
        (m) => `
      <li${m.self ? ' class="self"' : ''}>
        <span class="${dotClass(m)}" style="${m.away || m.dnd || m.call ? '' : `background:${m.color}`}"></span>
        <span class="who">${memberName(m)}</span>
        <span class="where">${statusOf(m)}${m.self ? ' ←' : ''}</span>
        <span class="page-chip">${t.demoPageChip ?? 'Page'}</span>
      </li>`
      )
      .join('');
  }

  function renderTabs() {
    tabsEl.innerHTML = SPACE_IDS.map((id) => {
      const n = members.filter((m) => m.space === id && !m.away).length;
      return `<button type="button" data-space="${id}" class="${id === view ? 'active' : ''}">${spaceLabel(id)}<span class="count">${n}</span></button>`;
    }).join('');
  }
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-space]');
    if (!btn) return;
    view = btn.dataset.space;
    renderTabs();
    if (reduced) draw(0);
  });

  /* ----- simulation ----- */
  let switchTimer = rnd(5, 8);

  function update(dt, t) {
    // wandering inside the current space
    for (const m of members) {
      if (!m.space) continue;
      if (m.fade < 0) {
        m.alpha = Math.max(0, m.alpha - dt * 2.4);
        if (m.alpha === 0) {
          m.space = m.nextSpace;
          m.nextSpace = null;
          place(m);
          m.fade = 1;
          renderRoster();
          renderTabs();
        }
        continue;
      }
      if (m.fade > 0) {
        m.alpha = Math.min(1, m.alpha + dt * 2.4);
        if (m.alpha === 1) m.fade = 0;
      }
      if (m.dwell > 0) {
        m.dwell -= dt;
      } else {
        const dx = m.tx - m.x;
        const dy = m.ty - m.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.012) {
          m.tx = rnd(PAD, 1 - PAD);
          m.ty = rnd(PAD + 0.05, 1 - PAD);
          m.dwell = rnd(1.2, 4.5);
        } else {
          const sp = 0.085 * dt; // normalized units / second
          m.x += (dx / d) * Math.min(sp, d);
          m.y += (dy / d) * Math.min(sp, d);
        }
      }
    }

    // occasionally someone switches space (tab change in real life)
    switchTimer -= dt;
    if (switchTimer <= 0) {
      switchTimer = rnd(6, 11);
      const m = movers[Math.floor(Math.random() * movers.length)];
      if (m.fade === 0) {
        const options = SPACE_IDS.filter((s) => s !== m.space);
        m.nextSpace = options[Math.floor(Math.random() * options.length)];
        m.fade = -1;
      }
    }
  }

  /* ----- drawing ----- */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw(t) {
    if (!resize()) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // floor grid
    ctx.strokeStyle = 'rgba(226, 217, 200, 0.55)';
    ctx.lineWidth = 1;
    const cell = 34;
    ctx.beginPath();
    for (let x = cell; x < w; x += cell) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = cell; y < h; y += cell) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    // furniture
    for (const f of FURNITURE[view] || []) {
      ctx.fillStyle = '#f1eadd';
      ctx.strokeStyle = '#e2d9c8';
      ctx.lineWidth = 1.5;
      if (f.kind === 'rug') {
        ctx.beginPath();
        ctx.ellipse(f.x * w, f.y * h, f.rx * w, f.ry * h, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (f.kind === 'desk') {
        roundRect((f.x - f.w / 2) * w, (f.y - f.h / 2) * h, f.w * w, f.h * h, 8);
        ctx.fill();
        ctx.stroke();
      } else if (f.kind === 'plant') {
        ctx.beginPath();
        ctx.arc(f.x * w, f.y * h, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(90, 143, 106, 0.28)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(f.x * w, f.y * h, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(90, 143, 106, 0.55)';
        ctx.fill();
      }
    }

    const here = members.filter((m) => m.space === view && m.alpha > 0);

    // proximity voice links
    for (let i = 0; i < here.length; i++) {
      for (let j = i + 1; j < here.length; j++) {
        const a = here[i];
        const b = here[j];
        const ax = a.x * w, ay = a.y * h;
        const bx = b.x * w, by = b.y * h;
        const d = Math.hypot(ax - bx, ay - by);
        if (d > NEAR) continue;
        const k = (1 - d / NEAR) * Math.min(a.alpha, b.alpha);
        ctx.strokeStyle = `rgba(216, 85, 46, ${0.55 * k})`;
        ctx.lineWidth = 1.8;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.setLineDash([]);
        // soft voice rings while connected
        const pulse = 16 + Math.sin(t * 2.6 + i * 1.7) * 3.5;
        for (const [px, py] of [[ax, ay], [bx, by]]) {
          ctx.beginPath();
          ctx.arc(px, py, pulse, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(216, 85, 46, ${0.28 * k})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
    }

    // avatars
    ctx.font = '700 10px "Zen Kaku Gothic New", sans-serif';
    ctx.textAlign = 'center';
    for (const m of here) {
      const x = m.x * w;
      const y = m.y * h;
      ctx.globalAlpha = m.alpha;
      // shadow
      ctx.beginPath();
      ctx.ellipse(x, y + 13, 9, 3.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(60, 45, 25, 0.16)';
      ctx.fill();
      // body
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fffdf8';
      ctx.stroke();
      if (m.self) {
        ctx.beginPath();
        ctx.arc(x, y, 15.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(216, 85, 46, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = '#6e6557';
      ctx.fillText(memberName(m), x, y + 28);
      ctx.globalAlpha = 1;
    }
  }

  /* ----- loop, paused when offscreen or tab hidden ----- */
  renderRoster();
  renderTabs();

  if (reduced) {
    // a single calm frame; no animation
    requestAnimationFrame(() => draw(0));
    return;
  }

  let visible = true;
  let running = false;
  let last = 0;

  function frame(now) {
    if (!visible || document.hidden) {
      running = false;
      return;
    }
    const t = now / 1000;
    const dt = Math.min(0.05, last ? t - last : 0.016);
    last = t;
    update(dt, t);
    draw(t);
    requestAnimationFrame(frame);
  }
  function ensureRunning() {
    if (!running && visible && !document.hidden) {
      running = true;
      last = 0;
      requestAnimationFrame(frame);
    }
  }

  new IntersectionObserver(
    (entries) => {
      visible = entries[0].isIntersecting;
      ensureRunning();
    },
    { threshold: 0.05 }
  ).observe(canvas);

  document.addEventListener('visibilitychange', ensureRunning);
  ensureRunning();
})();