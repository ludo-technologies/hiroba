/* Hiroba landing site — scroll reveals + the live hero demo.
   Vanilla JS, no dependencies. The demo pauses when offscreen (NFR-01 in spirit).

   The hero demo re-creates the actual client renderer (client/src/render.ts):
   a warm furnished floor — zone rugs, tables, stools, couches, plants — with
   person tokens, name chips, a proximity ring around self, a click-to-walk
   marker, and speaking ripples. Same palette, same floor plan, same idioms. */
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

  // World-unit space geometry, like the server hands the client.
  // kind mirrors SpaceDescriptor.kind — lobby vs team floor plans differ.
  const SPACES = {
    lobby: { w: 800, h: 600, near: 150, kind: 'lobby', capacity: 5 },
    dev: { w: 800, h: 600, near: 1100, kind: 'team', capacity: 5 },
    design: { w: 800, h: 600, near: 1100, kind: 'team', capacity: 5 },
  };

  /* ----- palette + constants, lifted from client/src/render.ts ----- */
  const FRAME_BG = '#241f1a';
  const FLOOR_TOP = '#efe3cb';
  const FLOOR_BOT = '#e4d3b4';
  const PLANK = 'rgba(120,92,58,0.05)';
  const ROOM_EDGE = 'rgba(90,70,45,0.35)';
  const WOOD = '#caa478';
  const WOOD_HI = '#d9b98e';
  const WOOD_EDGE = 'rgba(90,64,36,0.30)';
  const COUCH = '#aeb7bd';
  const COUCH_HI = '#c2cace';
  const POT = '#b27a4f';
  const LEAF = '#7fa863';
  const LEAF_HI = '#93bd75';
  const RUG_FOCUS = '#e7c9b2';
  const RUG_MEET = '#c2d2da';
  const RUG_LOUNGE = '#cdd8bf';
  const RUG_CAFE = '#ecd6ad';
  const RUG_COMMONS = '#e3d2c0';
  const ZONE_INK = 'rgba(74,58,40,0.42)';
  const NEAR_FILL = 'rgba(181,79,44,0.07)';
  const NEAR_STROKE = 'rgba(181,79,44,0.28)';
  const SELF_HALO = 'rgba(255,255,255,0.55)';
  const PEER_RADIUS = 34; // world units — matches client
  const SELF_RADIUS = 38;
  const SEAT_SIT_EPS = 14;
  const SEAT_SIT_SCALE = 0.88;
  const RIPPLE_COUNT = 3;
  const RIPPLE_PERIOD = 1.7;
  const WALK_SPEED = 130; // world units / second
  const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const STOOL_R = 0.022;

  /* ----- floor plan builder — mirrors client/src/render.ts buildFloor ----- */
  function pushStool(items, seats, x, y, r) {
    items.push({ kind: 'stool', x, y, r });
    seats.push({ x, y });
  }

  function buildLobbyFloor(dim) {
    const W = dim.w;
    const H = dim.h;
    const items = [];
    const seats = [];
    const sr = STOOL_R * W;

    items.push({ kind: 'rug', x: 0.05 * W, y: 0.06 * H, w: 0.36 * W, h: 0.32 * H, color: RUG_FOCUS, label: 'Focus' });
    for (let i = 0; i < 3; i++) {
      const dx = (0.1 + i * 0.1) * W;
      items.push({ kind: 'table', x: dx, y: 0.14 * H, w: 0.085 * W, h: 0.07 * H, round: false });
      pushStool(items, seats, dx + 0.042 * W, 0.25 * H, sr);
    }
    items.push({ kind: 'plant', x: 0.07 * W, y: 0.33 * H, r: 0.035 * W });

    items.push({ kind: 'rug', x: 0.58 * W, y: 0.06 * H, w: 0.37 * W, h: 0.32 * H, color: RUG_MEET, label: 'Meeting' });
    const mcx = 0.765 * W, mcy = 0.22 * H, mtr = 0.085 * W;
    items.push({ kind: 'table', x: mcx - mtr, y: mcy - mtr, w: mtr * 2, h: mtr * 2, round: true });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      pushStool(items, seats, mcx + Math.cos(a) * mtr * 1.65, mcy + Math.sin(a) * mtr * 1.65, sr);
    }

    items.push({ kind: 'rug', x: 0.05 * W, y: 0.6 * H, w: 0.37 * W, h: 0.33 * H, color: RUG_LOUNGE, label: 'Lounge' });
    items.push({ kind: 'couch', x: 0.08 * W, y: 0.66 * H, w: 0.1 * W, h: 0.2 * H });
    for (const [sx, sy] of [[0.13, 0.72], [0.13, 0.8], [0.13, 0.88]]) {
      seats.push({ x: sx * W, y: sy * H });
    }
    items.push({ kind: 'table', x: 0.22 * W, y: 0.72 * H, w: 0.11 * W, h: 0.1 * H, round: true });
    items.push({ kind: 'plant', x: 0.37 * W, y: 0.66 * H, r: 0.035 * W });

    items.push({ kind: 'rug', x: 0.58 * W, y: 0.6 * H, w: 0.37 * W, h: 0.33 * H, color: RUG_CAFE, label: 'Café' });
    items.push({ kind: 'table', x: 0.62 * W, y: 0.66 * H, w: 0.29 * W, h: 0.065 * H, round: false });
    for (let i = 0; i < 4; i++) {
      pushStool(items, seats, (0.66 + i * 0.07) * W, 0.76 * H, sr);
    }
    items.push({ kind: 'plant', x: 0.9 * W, y: 0.86 * H, r: 0.035 * W });

    const cr = 0.12 * Math.min(W, H);
    items.push({ kind: 'rugRound', x: 0.5 * W, y: 0.5 * H, r: cr, color: RUG_COMMONS, label: 'Commons' });
    items.push({ kind: 'table', x: 0.47 * W, y: 0.47 * H, w: 0.06 * W, h: 0.06 * H, round: true });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      seats.push({
        x: 0.5 * W + Math.cos(a) * cr * 0.72,
        y: 0.5 * H + Math.sin(a) * cr * 0.72,
      });
    }

    return { items, seats };
  }

  function buildTeamFloor(dim) {
    const W = dim.w;
    const H = dim.h;
    const items = [];
    const seats = [];
    const n = Math.max(2, Math.min(dim.capacity || 5, 8));
    const minSide = Math.min(W, H);
    const sr = STOOL_R * W * 1.05;

    items.push({ kind: 'rugRound', x: 0.5 * W, y: 0.5 * H, r: 0.3 * minSide, color: RUG_MEET });
    const tr = 0.1 * minSide;
    items.push({
      kind: 'table',
      x: 0.5 * W - tr,
      y: 0.5 * H - tr,
      w: tr * 2,
      h: tr * 2,
      round: true,
    });
    const ring = tr * 1.75;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      pushStool(
        items,
        seats,
        0.5 * W + Math.cos(a) * ring,
        0.5 * H + Math.sin(a) * ring,
        sr,
      );
    }
    items.push({ kind: 'plant', x: 0.08 * W, y: 0.1 * H, r: 0.038 * W });
    items.push({ kind: 'plant', x: 0.92 * W, y: 0.9 * H, r: 0.038 * W });

    return { items, seats };
  }

  function buildFloor(dim) {
    return dim.kind === 'team' ? buildTeamFloor(dim) : buildLobbyFloor(dim);
  }

  const FLOORS = {};
  for (const id of SPACE_IDS) FLOORS[id] = buildFloor(SPACES[id]);
  // Commons seats are the last 5 on the lobby plan (see buildLobbyFloor).
  const COMMONS_SEATS = { first: FLOORS.lobby.seats.length - 5, count: 5 };

  const members = [
    { id: 'self', color: '#d8552e', space: 'lobby', self: true },
    { id: 'ren', color: '#5a8f6a', space: 'lobby' },
    { id: 'yuu', color: '#34506b', space: 'dev' },
    { id: 'kan', color: '#c0913b', space: 'dev', call: true },
    { id: 'hina', color: '#8d6a9f', space: 'design', dnd: true, muted: true },
    { id: 'miu', color: '#a99e8c', space: null, away: true },
  ];
  members.forEach((m, i) => {
    m.seed = i * 1.7;
    m.alpha = 1;
    m.fade = 0; // -1 leaving, +1 entering, 0 settled
    m.level = 0; // smoothed speaking level 0..1
    m.walking = false;
  });
  const memberName = (m) => {
    const key = `demoMember${m.id.charAt(0).toUpperCase()}${m.id.slice(1)}`;
    return t[key] ?? m.id;
  };
  // members who wander between spaces over time
  const movers = members.filter((m) => m.id === 'ren' || m.id === 'yuu');

  const rnd = (a, b) => a + Math.random() * (b - a);

  /** A seat in m's space that no one else is sitting at / walking to. */
  function freeSeat(m) {
    const seats = FLOORS[m.space].seats;
    const open = seats.filter((s) =>
      members.every(
        (o) => o === m || o.space !== m.space || Math.hypot((o.tx ?? o.x) - s.x, (o.ty ?? o.y) - s.y) > 60
      )
    );
    const pool = open.length ? open : seats;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Sit m down at a free seat immediately (spawn / space switch). */
  function placeAtSeat(m, seat) {
    const s = seat ?? freeSeat(m);
    m.x = m.tx = s.x + rnd(-8, 8);
    m.y = m.ty = s.y + rnd(-8, 8);
    m.walking = false;
    m.dwell = rnd(5, 12);
  }

  /** Start walking m toward a new seat. */
  function walkToNewSeat(m) {
    const s = freeSeat(m);
    m.tx = s.x + rnd(-8, 8);
    m.ty = s.y + rnd(-8, 8);
    m.walking = true;
    if (m.self) walkTarget = { x: m.tx, y: m.ty };
  }

  // Opening scene: self and Ren chat at the lobby commons; Yuu and Kan sit
  // around the Dev team table (Kan is on a page call); Hina (DND) is in Design.
  placeAtSeat(members[0], FLOORS.lobby.seats[COMMONS_SEATS.first]);
  placeAtSeat(members[1], FLOORS.lobby.seats[COMMONS_SEATS.first + 2]);
  placeAtSeat(members[2], FLOORS.dev.seats[1]);
  placeAtSeat(members[3], FLOORS.dev.seats[3]);
  placeAtSeat(members[4], FLOORS.design.seats[2]);
  members[5].x = members[5].tx = 0;
  members[5].y = members[5].ty = 0;

  let view = 'lobby';
  let walkTarget = null; // click-to-walk marker, in world units

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
    // In the real client, switching tabs moves *you* into that space.
    const self = members[0];
    if (self.space !== view) {
      if (reduced) {
        self.space = view;
        placeAtSeat(self);
      } else {
        self.nextSpace = view;
        if (self.fade === 0) self.fade = -1;
      }
      walkTarget = null;
      renderRoster();
    }
    renderTabs();
    if (reduced) draw(0);
  });

  /* ----- simulation ----- */
  let switchTimer = rnd(7, 11);

  /** Same-space members within voice range of m (excluding m). */
  function neighborsOf(m) {
    const near = SPACES[m.space].near;
    return members.filter(
      (o) => o !== m && o.space === m.space && o.fade === 0 && Math.hypot(o.x - m.x, o.y - m.y) < near
    );
  }

  /** Target speaking level: turn-taking chatter within a proximity group. */
  function speakTarget(m, t) {
    if (m.away || m.dnd || !m.space || m.fade !== 0) return 0;
    const osc = 0.5 + 0.28 * Math.sin(t * 6.3 + m.seed * 4.1);
    // A page call is 1:1 across spaces — Kan talks in bursts even when alone.
    if (m.call) return Math.sin(t * 0.9 + m.seed) > 0.15 ? osc : 0;
    const group = [m, ...neighborsOf(m)];
    if (group.length < 2) return 0;
    group.sort((a, b) => (a.id < b.id ? -1 : 1));
    const turn = Math.floor(t / 3.2) % group.length;
    return group[turn] === m ? osc : 0;
  }

  function update(dt, t) {
    for (const m of members) {
      if (!m.space) continue;
      // space-switch fades (tab change in real life)
      if (m.fade < 0) {
        m.alpha = Math.max(0, m.alpha - dt * 2.4);
        if (m.alpha === 0) {
          m.space = m.nextSpace;
          m.nextSpace = null;
          placeAtSeat(m);
          m.fade = 1;
          renderRoster();
          renderTabs();
        }
        m.level = 0;
        continue;
      }
      if (m.fade > 0) {
        m.alpha = Math.min(1, m.alpha + dt * 2.4);
        if (m.alpha === 1) m.fade = 0;
      }

      // sit for a while, then walk to another seat
      if (m.walking) {
        const dx = m.tx - m.x;
        const dy = m.ty - m.y;
        const d = Math.hypot(dx, dy);
        const step = WALK_SPEED * dt;
        if (d <= step) {
          m.x = m.tx;
          m.y = m.ty;
          m.walking = false;
          m.dwell = rnd(6, 14);
          if (m.self) walkTarget = null;
        } else {
          m.x += (dx / d) * step;
          m.y += (dy / d) * step;
        }
      } else if ((m.dwell -= dt) <= 0) {
        walkToNewSeat(m);
      }

      // speaking level, eased like the client's smoothed voice levels
      m.level += (speakTarget(m, t) - m.level) * Math.min(1, dt * 6);
    }

    // occasionally someone switches space (tab change in real life)
    switchTimer -= dt;
    if (switchTimer <= 0) {
      switchTimer = rnd(9, 15);
      const m = movers[Math.floor(Math.random() * movers.length)];
      if (m.fade === 0) {
        const options = SPACE_IDS.filter((s) => s !== m.space);
        // bias toward the lobby so the default view stays lively
        m.nextSpace =
          options.includes('lobby') && Math.random() < 0.6
            ? 'lobby'
            : options[Math.floor(Math.random() * options.length)];
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
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return [181, 79, 44];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function lighten(hex, k) {
    const [r, g, b] = parseHex(hex);
    return `rgb(${Math.round(r + (255 - r) * k)},${Math.round(g + (255 - g) * k)},${Math.round(b + (255 - b) * k)})`;
  }
  function pickInk(hex) {
    const [r, g, b] = parseHex(hex);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? 'rgba(40,30,18,0.95)' : 'rgba(255,255,255,0.96)';
  }

  function zoneLabel(text, cx, y) {
    ctx.save();
    ctx.font = `700 8px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ZONE_INK;
    // manual letter-spacing for the client's calm signage feel
    const letters = text.toUpperCase().split('');
    const sp = 1.8;
    let total = -sp;
    for (const ch of letters) total += ctx.measureText(ch).width + sp;
    let x = cx - total / 2;
    for (const ch of letters) {
      const cw = ctx.measureText(ch).width;
      ctx.fillText(ch, x + cw / 2, y);
      x += cw + sp;
    }
    ctx.restore();
  }

  function drawFurniture(ox, oy, scale, items) {
    const X = (wx) => ox + wx * scale;
    const Y = (wy) => oy + wy * scale;
    for (const it of items) {
      switch (it.kind) {
        case 'rug': {
          const x = X(it.x), y = Y(it.y), w = it.w * scale, h = it.h * scale;
          roundRect(x, y, w, h, 14 * scale + 4);
          ctx.fillStyle = it.color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(90,70,45,0.12)';
          ctx.stroke();
          if (it.label) zoneLabel(it.label, x + w / 2, y + 9 * scale + 4);
          break;
        }
        case 'rugRound': {
          const x = X(it.x), y = Y(it.y), r = it.r * scale;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = it.color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(90,70,45,0.12)';
          ctx.stroke();
          if (it.label) zoneLabel(it.label, x, y - r + 9 * scale + 4);
          break;
        }
        case 'table': {
          const x = X(it.x), y = Y(it.y), w = it.w * scale, h = it.h * scale;
          const rad = it.round ? Math.min(w, h) / 2 : 5;
          // soft drop shadow
          ctx.fillStyle = 'rgba(70,50,28,0.16)';
          roundRect(x + 2, y + 3, w, h, rad);
          ctx.fill();
          roundRect(x, y, w, h, rad);
          const tg = ctx.createLinearGradient(0, y, 0, y + h);
          tg.addColorStop(0, WOOD_HI);
          tg.addColorStop(1, WOOD);
          ctx.fillStyle = tg;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = WOOD_EDGE;
          ctx.stroke();
          break;
        }
        case 'couch': {
          const x = X(it.x), y = Y(it.y), w = it.w * scale, h = it.h * scale;
          ctx.fillStyle = 'rgba(70,50,28,0.16)';
          roundRect(x + 2, y + 3, w, h, 7);
          ctx.fill();
          roundRect(x, y, w, h, 7);
          ctx.fillStyle = COUCH;
          ctx.fill();
          roundRect(x + w * 0.16, y + h * 0.16, w * 0.68, h * 0.68, 5);
          ctx.fillStyle = COUCH_HI;
          ctx.fill();
          break;
        }
        case 'stool': {
          const x = X(it.x), y = Y(it.y), r = it.r * scale;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = WOOD;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
          ctx.fillStyle = WOOD_HI;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = WOOD_EDGE;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'plant': {
          const x = X(it.x), y = Y(it.y), r = it.r * scale;
          ctx.beginPath();
          ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
          ctx.fillStyle = POT;
          ctx.fill();
          for (const [dx, dy, rr] of [[0, -0.5, 0.85], [-0.55, -0.1, 0.6], [0.55, -0.1, 0.6], [0, 0.15, 0.7]]) {
            ctx.beginPath();
            ctx.arc(x + dx * r, y + dy * r, rr * r, 0, Math.PI * 2);
            ctx.fillStyle = rr > 0.7 ? LEAF_HI : LEAF;
            ctx.fill();
          }
          break;
        }
      }
    }
  }

  /** Concentric rings radiating outward in time, scaled by voice level. */
  function drawRipples(t, sx, sy, r, color, alpha, level) {
    const reach = r * (1.6 + 2.2 * level);
    const tt = t / RIPPLE_PERIOD;
    ctx.save();
    ctx.lineWidth = 1.5;
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      const phase = (tt + i / RIPPLE_COUNT) % 1;
      const rr = r + phase * (reach - r);
      ctx.globalAlpha = alpha * (1 - phase) * (0.22 + 0.5 * level);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMuteBadge(cx, cy, r) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,251,243,0.96)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,70,45,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(224,108,72,0.95)';
    ctx.lineWidth = Math.max(1.4, r * 0.22);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // Chips queue during the token pass and flush on top, so a nearby token
  // can cover a body but never hide who someone is (mirrors the client).
  const chipQueue = [];

  function drawNameChip(name, cx, top, isSelf) {
    ctx.font = `600 9px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(name).width;
    const chipW = w + 12;
    const chipH = 14;
    roundRect(cx - chipW / 2, top, chipW, chipH, 6);
    ctx.fillStyle = isSelf ? 'rgba(255,252,246,0.96)' : 'rgba(255,252,246,0.86)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = isSelf ? 'rgba(181,79,44,0.6)' : 'rgba(90,70,45,0.14)';
    ctx.stroke();
    ctx.fillStyle = '#4a3a28';
    ctx.fillText(name, cx, top + 2.5);
  }

  /** Gentle overshoot for a lively-but-calm spawn (client's easeOutBack). */
  function easeOutBack(v) {
    const c1 = 1.70158;
    const x = Math.min(1, Math.max(0, v)) - 1;
    return 1 + (c1 + 1) * x * x * x + c1 * x * x;
  }

  function isSeated(m) {
    if (!m.space || m.walking) return false;
    const seats = FLOORS[m.space]?.seats;
    if (!seats) return false;
    return seats.some((s) => Math.hypot(m.x - s.x, m.y - s.y) <= SEAT_SIT_EPS);
  }

  function drawPeer(t, ox, oy, scale, m) {
    const seated = isSeated(m);
    const sitNudge = seated ? 2.5 * scale : 0;
    const sx = ox + m.x * scale;
    const sy = oy + m.y * scale + sitNudge;
    const appear = m.fade > 0 ? easeOutBack(m.alpha) : m.alpha;
    const sitScale = seated ? SEAT_SIT_SCALE : 1;
    const r = (m.self ? SELF_RADIUS : PEER_RADIUS) * scale * (0.6 + 0.4 * appear) * sitScale;

    ctx.save();
    ctx.globalAlpha = m.alpha;

    if (m.level > 0.04) drawRipples(t, sx, sy, r, m.color, m.alpha, m.level);

    // grounding shadow
    const sh = ctx.createRadialGradient(sx, sy + r * 0.55, r * 0.2, sx, sy + r * 0.62, r * 1.5);
    sh.addColorStop(0, 'rgba(70,50,28,0.32)');
    sh.addColorStop(1, 'rgba(70,50,28,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(sx, sy + r * 0.66, r * 1.35, r * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();

    if (m.self) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + Math.max(3, r * 0.2), 0, Math.PI * 2);
      ctx.fillStyle = SELF_HALO;
      ctx.fill();
    }

    // disc with a soft top highlight
    const body = ctx.createRadialGradient(sx, sy - r * 0.4, r * 0.1, sx, sy, r);
    body.addColorStop(0, lighten(m.color, 0.24));
    body.addColorStop(1, m.color);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();

    // initial letter
    const name = memberName(m);
    ctx.fillStyle = pickInk(m.color);
    ctx.font = `600 ${Math.max(9, Math.round(r * 0.72))}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name[0] ?? '?').toUpperCase(), sx, sy + 0.5);

    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(m.self ? 2 : 1.2, r * (m.self ? 0.1 : 0.07));
    ctx.strokeStyle = m.self ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.7)';
    ctx.stroke();

    if (m.muted && !m.self) drawMuteBadge(sx + r * 0.72, sy - r * 0.72, Math.max(5, r * 0.32));

    chipQueue.push({ name, x: sx, top: sy + r + 5, isSelf: m.self, alpha: m.alpha });

    ctx.restore();
  }

  function draw(t) {
    if (!resize()) return;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const dim = SPACES[view];
    const scale = Math.min(cw / dim.w, ch / dim.h);
    const ox = (cw - dim.w * scale) / 2;
    const oy = (ch - dim.h * scale) / 2;
    const rw = dim.w * scale;
    const rh = dim.h * scale;

    // dark wooden frame outside the room
    ctx.fillStyle = FRAME_BG;
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, rw, rh);
    ctx.clip();

    // warm wood floor with faint plank seams
    const g = ctx.createLinearGradient(0, oy, 0, oy + rh);
    g.addColorStop(0, FLOOR_TOP);
    g.addColorStop(1, FLOOR_BOT);
    ctx.fillStyle = g;
    ctx.fillRect(ox, oy, rw, rh);
    const seam = 110 * scale;
    ctx.strokeStyle = PLANK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = oy + seam; y < oy + rh; y += seam) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(ox, yy);
      ctx.lineTo(ox + rw, yy);
    }
    ctx.stroke();

    drawFurniture(ox, oy, scale, FLOORS[view].items);

    const self = members[0];
    const here = members.filter((m) => m.space === view && m.alpha > 0);

    // proximity voice range around self (the one clay accent)
    if (self.space === view && self.alpha > 0) {
      ctx.save();
      ctx.globalAlpha = self.alpha;
      ctx.beginPath();
      ctx.arc(ox + self.x * scale, oy + self.y * scale, dim.near * scale, 0, Math.PI * 2);
      ctx.fillStyle = NEAR_FILL;
      ctx.fill();
      ctx.strokeStyle = NEAR_STROKE;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 8]);
      ctx.stroke();
      ctx.restore();
    }

    // click-to-walk destination marker
    if (walkTarget && self.space === view) {
      const wx = ox + walkTarget.x * scale;
      const wy = oy + walkTarget.y * scale;
      const phase = t % 1;
      ctx.beginPath();
      ctx.arc(wx, wy, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(181,79,44,0.85)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(wx, wy, 6 + 4.5 * phase, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(181,79,44,${0.55 * (1 - phase)})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // peers first, self on top so it's never occluded
    chipQueue.length = 0;
    for (const m of here) if (!m.self) drawPeer(t, ox, oy, scale, m);
    if (self.space === view && self.alpha > 0) drawPeer(t, ox, oy, scale, self);

    // name chips above every token (self queued last, so it wins)
    for (const c of chipQueue) {
      ctx.globalAlpha = c.alpha;
      drawNameChip(c.name, c.x, c.top, c.isSelf);
    }
    ctx.globalAlpha = 1;
    chipQueue.length = 0;

    // vignette for depth
    const vg = ctx.createRadialGradient(
      ox + rw / 2, oy + rh / 2, (Math.hypot(rw, rh) / 2) * 0.55,
      ox + rw / 2, oy + rh / 2, Math.hypot(rw, rh) / 2
    );
    vg.addColorStop(0, 'rgba(60,40,20,0)');
    vg.addColorStop(1, 'rgba(60,40,20,0.16)');
    ctx.fillStyle = vg;
    ctx.fillRect(ox, oy, rw, rh);

    ctx.restore();

    // room edge frames everything
    ctx.lineWidth = 1;
    ctx.strokeStyle = ROOM_EDGE;
    ctx.strokeRect(ox + 0.5, oy + 0.5, rw - 1, rh - 1);
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
