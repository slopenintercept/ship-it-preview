/*
 * product / storm: the backdrop. Heavy glyph clouds over a wet plain, a pine
 * treeline and a radio mast on the ridge, rain that sweeps with the gusts,
 * mist along the horizon, leaves blown across in strong gusts, sheet
 * lightning inside the clouds, and distant pale bolts from the weather module.
 *
 * A click anywhere off the interface calls a strike there, in a random colour:
 * it lights the whole field, reflects in the wet plain, and the clouds
 * rumble a moment later. It also strikes on its own, rarely (sometimes the mast).
 * The cursor is a small neutral lamp. The field dims behind [data-dim] and the
 * app window, so text and screenshots stay clean.
 */
(function () {
  'use strict';

  const { clamp, rand, noise, hash, smoothstep, pack, strokeGlyph, Grid } = window.AsciiEngine;
  const { Environment } = window.AsciiWeather;

  const FAMILY = '"JetBrains Mono", ui-monospace, Consolas, monospace';
  const RAIN_PK = pack([128, 150, 205]);
  const SKY_FLASH_PK = pack([190, 205, 255]);
  const MIST_PK = pack([120, 136, 172]);
  const LEAF_PKS = [pack([120, 104, 72]), pack([96, 112, 70]), pack([140, 118, 80])];
  const PINE_DARK = pack([34, 66, 70]);
  const PINE_MID = pack([52, 96, 92]);
  const MAST_PK = pack([104, 114, 140]);
  const BEACON = [255, 64, 52];
  const LAMP = [215, 225, 245];
  const BOLT_LIFE = 1.7;
  const C = (ch) => ch.charCodeAt(0);
  // Clicks on these never call a strike.
  const UI = 'a, button, input, dialog, [role="tab"], [data-dim], .frame, .tabs';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.getElementById('field');

  /* --- the startup intro: decided before first paint ------------------------
   * First visit in a session (or ?intro): the page waits in the dark, the storm
   * decodes in, and a strike lands on the Ship It bolt, built out of glyphs.
   * The bolt holds, the name types in under it, then it breaks into the rain and
   * the page fades up. Any key, click or scroll skips ahead. Reduced motion and
   * ?intro=0 never play it. */
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  let seen = false;
  try { seen = sessionStorage.getItem('shipit.intro') === '1'; sessionStorage.setItem('shipit.intro', '1'); } catch (e) { /* storage blocked: play it */ }
  const playIntro = !reduced && q.get('intro') !== '0' && (q.has('intro') || !seen);
  const INTRO = { strike: 1.5, type: 1.85, breakAt: 2.75, show: 2.85, end: 3.6 };
  let introMark = null;
  function introDone() {
    if (!root.classList.contains('intro')) return;
    root.classList.remove('intro');
    if (introMark) introMark.classList.add('gone');
    document.dispatchEvent(new Event('shipit:intro-done'));
  }
  if (playIntro) {
    root.classList.add('intro');
    introMark = document.createElement('div');
    introMark.className = 'intro-mark';
    introMark.setAttribute('aria-hidden', 'true');
    document.body.appendChild(introMark);
    setTimeout(introDone, 7000); // failsafe: never leave the page hidden
  }

  // A random strike colour: any vivid hue, now and then a plain white-blue.
  function strikeColour() {
    if (Math.random() < 0.15) return [215, 228, 255];
    const hue = Math.random() * 6, s = 0.95, l = 0.6;
    const q = l + s - l * s, p = 2 * l - q;
    const ch = (t) => {
      t = ((t % 6) + 6) % 6;
      const v = t < 1 ? p + (q - p) * t : t < 3 ? q : t < 4 ? p + (q - p) * (4 - t) : p;
      return Math.round(v * 255);
    };
    return [ch(hue + 2), ch(hue), ch(hue - 2)];
  }
  const towardWhite = (rgb, k) => rgb.map((v) => Math.round(v + (255 - v) * k));

  function mount() {
    const grid = new Grid(canvas, FAMILY);
    const env = new Environment();
    env.setHour(23);
    env.setWeather('storm');
    Object.assign(env, { cloud: 1, wet: 1, storm: 1, fog: 0, snow: 0 });

    let w = 0, h = 0, hz = 0, hzRow = 0;
    let trees = [], mast = null;
    const s = {
      cx: -999, cy: -999, tx: -999, ty: -999,
      strikes: [], sheets: [], leaves: [],
      nextStrike: 3.5, nextSheet: 1.5, gust: 0,
      running: false, raf: 0, last: 0,
      intro: playIntro ? { t: 0, logo: null, struck: false, broke: false, shown: false } : null,
    };
    if (s.intro) { s.nextStrike = INTRO.end + 9; s.nextSheet = 0.35; }

    /* --- layout --------------------------------------------------------- */

    const ridgeRow = (c) => hzRow - 2 - Math.floor(4 * noise(c * 0.035, 3, 9) + 2 * noise(c * 0.14, 8, 3));

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      grid.resize(w, h, dpr, w < 600 ? 6 : 7);
      hzRow = Math.round((h * 0.7) / grid.ch); // most of the frame is sky
      hz = hzRow * grid.ch;
      placeRidge();
      grid.groundStale = true;
      if (reduced) renderStill();
    }

    // Pines in clumps along the ridge, and one radio mast toward the right.
    function placeRidge() {
      trees = [];
      const mastCol = Math.round(grid.cols * (w < 760 ? 0.82 : 0.9));
      mast = { c: mastCol, base: ridgeRow(mastCol), height: Math.max(10, Math.round(grid.rows * 0.2)) };
      for (let c = 2; c < grid.cols - 2; c++) {
        if (Math.abs(c - mastCol) < 8) continue;
        const clump = noise(c * 0.04, 1, 61);
        if (clump < 0.42 || hash(c, 3, 19) > 0.22 + clump * 0.3) continue;
        const height = Math.round(5 + 9 * hash(c, 5, 23) * clump + 3 * clump);
        trees.push({ c, base: ridgeRow(c) + 1, height, phase: hash(c, 9, 4) * 6 });
        c += 2 + Math.floor(hash(c, 2, 8) * 3);
      }
    }

    /* --- the ground layer: clouds, far ridge, wet plain ------------------ */

    function groundAt(i, c, r) {
      const t = env.time;
      if (r < hzRow) {
        const sky = r / hzRow; // 0 at the top, 1 at the horizon
        if (r >= ridgeRow(c)) {
          grid.gGlyph[i] = grid.ramp(6, i);
          grid.gColor[i] = pack([26, 33, 54]);
          grid.gAlpha[i] = 0.95;
          return;
        }
        const drift = t * 0.45 + env.wind * t * 0.4;
        let n = noise(c * 0.045 + drift, r * 0.12, 11) * 0.62 + noise(c * 0.12 + drift * 1.7, r * 0.3, 23) * 0.38;
        n *= 1.12 - 0.3 * sky; // heaviest overhead, still full down to the hills
        const k = clamp(Math.round((n - 0.2) * 11), 0, 7);
        if (k <= 0) { grid.gGlyph[i] = 0; return; }
        grid.gGlyph[i] = grid.ramp(k, i);
        grid.gColor[i] = pack([62 + n * 52, 76 + n * 58, 112 + n * 66]);
        grid.gAlpha[i] = 0.36 + 0.46 * Math.min(1, k / 6);
        return;
      }
      const d = (r - hzRow) / Math.max(1, grid.rows - hzRow); // 0 far .. 1 near
      const n = noise(c * 0.17, r * 0.55 + t * 0.7, 5);
      if (n < 0.46) { grid.gGlyph[i] = 0; return; }
      grid.gGlyph[i] = n > 0.66 ? 126 : 45;
      grid.gColor[i] = pack([74, 96, 146]);
      grid.gAlpha[i] = 0.26 + 0.34 * d;
    }

    /* --- wind ------------------------------------------------------------ */

    // A steady wind to the right with gusts on top; the rain leans with it.
    function stepWind(dt) {
      const g = (noise(env.time * 0.22, 1, 5) - 0.5) * 2 + (noise(env.time * 0.9, 4, 7) - 0.5) * 0.6;
      s.gust = clamp(g, -1, 1);
      env.setWind(0.22 + 0.4 * s.gust);
      const vx = env.wind * 260, k = Math.min(1, dt * 3);
      for (const d of env.drops) if (d.kind === 'rain') d.vx += (vx - d.vx) * k;
    }

    /* --- the strike ------------------------------------------------------ */

    // free: land exactly at y (the intro aims at the bolt's tip, high up).
    function strike(x, y, free) {
      const gy = free ? y : clamp(y, h * 0.3, h * 0.96);
      const pts = [[x, -8]];
      let px = x, py = -8, dir = Math.random() < 0.5 ? 1 : -1;
      while (py < gy) {
        py = Math.min(gy, py + rand(grid.ch * 2.2, grid.ch * 4.4));
        px += dir * rand(grid.cw * 2, grid.cw * 7);
        if (Math.random() < 0.7) dir = -dir;
        pts.push([px, py]);
      }
      const dx = x - px; // land exactly on (x, gy)
      for (const p of pts) p[0] += dx * ((p[1] + 8) / (gy + 8));
      const branches = [];
      const nb = 1 + Math.floor(Math.random() * 3);
      for (let b = 0; b < nb; b++) {
        const at = 1 + Math.floor(Math.random() * Math.max(1, pts.length - 3));
        const bp = [pts[Math.min(at, pts.length - 1)].slice()];
        const side = Math.random() < 0.5 ? -1 : 1;
        const len = 2 + Math.floor(Math.random() * 3);
        for (let k = 0; k < len; k++) {
          const last = bp[bp.length - 1];
          bp.push([last[0] + side * rand(grid.cw * 2, grid.cw * 6), last[1] + rand(grid.ch * 1.5, grid.ch * 3.5)]);
        }
        branches.push(bp);
      }
      const rgb = strikeColour();
      s.strikes.push({ pts, branches, born: env.time, gx: x, gy, rgb, pk: pack(rgb), hot: pack(towardWhite(rgb, 0.6)) });
      // The clouds rumble a moment later, near where it came down.
      s.sheets.push({ x: x + rand(-160, 160), y: rand(h * 0.08, h * 0.3), born: env.time + rand(0.6, 1.1), rgb: towardWhite(rgb, 0.5), k: 0.5 });
    }

    function drawStrikes() {
      let peak = 0;
      s.strikes = s.strikes.filter((b) => env.time - b.born < BOLT_LIFE);
      for (const b of s.strikes) {
        const age = env.time - b.born;
        // Two quick flashes, then the afterglow.
        const f = age < 0.06 ? age / 0.06 : age < 0.2 ? 1 : age < 0.27 ? 0.35 : age < 0.4 ? 1 : Math.exp(-(age - 0.4) * 2.4);
        const ink = age < 0.45 ? 1 : Math.max(0, 1 - (age - 0.45) / 0.85);
        peak = Math.max(peak, f);
        [b.pts, ...b.branches].forEach((line, n) => {
          const main = n === 0;
          for (let i = 1; i < line.length; i++) {
            const [x0, y0] = line[i - 1], [x1, y1] = line[i];
            if (main) grid.stroke(x0 + grid.cw, y0, x1 + grid.cw, y1, b.pk, ink * 0.7, 5);
            grid.stroke(x0, y0, x1, y1, main ? b.hot : b.pk, ink * (main ? 1 : 0.75), 6);
            // Its reflection in the wet plain: mirrored at the horizon, squashed, rippling.
            if (y0 < hz && y1 < hz) {
              const ry0 = hz + (hz - y0) * 0.42, ry1 = hz + (hz - y1) * 0.42;
              if (ry0 < h || ry1 < h) {
                const wob = (y) => Math.sin(y * 0.09 + env.time * 7) * grid.cw * 1.4;
                grid.stroke(x0 + wob(ry0), ry0, x1 + wob(ry1), ry1, b.pk, ink * (main ? 0.32 : 0.18), 4);
              }
            }
          }
        });
        const step = Math.ceil(b.pts.length / 6);
        for (let i = 0; i < b.pts.length; i += step) grid.addLight(b.pts[i][0], b.pts[i][1], 250, f * 0.5, b.rgb);
        grid.addLight(b.gx, b.gy, 380, f * 0.95, b.rgb);
        grid.addLight(b.gx, hz + (h - hz) * 0.4, 320, f * 0.3, b.rgb); // the plain shines back
        if (age < 0.9) { // a ring of glyphs spreads where it lands
          const rr = age * 240, fade = 1 - age / 0.9;
          for (let a = 0; a < 20; a++) {
            const ang = (a / 20) * Math.PI * 2;
            const i = grid.cellAt(b.gx + Math.cos(ang) * rr * 2, b.gy + Math.sin(ang) * rr * 0.34);
            if (i >= 0) grid.put(i, age < 0.3 ? 42 : 111, b.pk, fade * 0.85, 5);
          }
        }
      }
      return peak;
    }

    /* --- sheet lightning: light flickering inside the clouds ------------- */

    function drawSheets(dt) {
      s.nextSheet -= dt;
      if (s.nextSheet <= 0) {
        s.nextSheet = rand(2.2, 5.5);
        s.sheets.push({ x: rand(0, w), y: rand(h * 0.05, h * 0.4), born: env.time, rgb: [176, 190, 255], k: rand(0.25, 0.45) });
      }
      s.sheets = s.sheets.filter((sh) => env.time - sh.born < 0.7);
      let flash = 0;
      for (const sh of s.sheets) {
        const age = env.time - sh.born;
        if (age < 0) continue;
        // Three uneven flickers.
        const f = age < 0.08 ? 1 : age < 0.16 ? 0.2 : age < 0.26 ? 0.75 : age < 0.36 ? 0.1 : Math.max(0, 0.45 - (age - 0.36) * 1.3);
        grid.addLight(sh.x, sh.y, 340, f * sh.k, sh.rgb);
        flash = Math.max(flash, f * sh.k * 0.35);
      }
      return flash;
    }

    /* --- the ridge: pines that bend in the gusts, the mast --------------- */

    function drawTrees() {
      const t = env.time;
      for (const tr of trees) {
        const sway = s.gust * 0.8 + Math.sin(t * 2.3 + tr.phase) * 0.18 * (0.4 + Math.abs(s.gust));
        for (let k = 0; k < tr.height; k++) {
          const r = tr.base - tr.height + k;
          if (r < 0 || r >= grid.rows) continue;
          const up = 1 - k / tr.height; // 1 at the tip
          const lean = Math.round(sway * up * up * 3);
          const trunk = k >= tr.height - 1;
          const half = trunk ? 0 : Math.min(3, Math.floor(k * 0.42));
          for (let dc = -half; dc <= half; dc++) {
            const c = tr.c + dc + lean;
            if (c < 0 || c >= grid.cols) continue;
            let code;
            if (trunk) code = C('|');
            else if (k === 0) code = sway > 0.45 ? C('/') : sway < -0.45 ? C('\\') : C('^');
            else if (dc === -half) code = C('/');
            else if (dc === half) code = C('\\');
            else code = (k + dc) % 3 === 0 ? C('A') : C('^');
            grid.put(r * grid.cols + c, code, dc === 0 || trunk ? PINE_MID : PINE_DARK, 0.92, 2);
          }
        }
      }
    }

    function drawMast() {
      if (!mast) return;
      const top = mast.base - mast.height;
      for (let k = 0; k <= mast.height; k++) {
        const r = top + k;
        if (r < 0 || r >= grid.rows) continue;
        const half = Math.floor(k / 6);
        for (let dc = -half; dc <= half; dc++) {
          const c = mast.c + dc;
          if (c < 0 || c >= grid.cols) continue;
          let code;
          if (k === 0) code = C('A');
          else if (half === 0) code = C('|');
          else if (dc === -half) code = C('/');
          else if (dc === half) code = C('\\');
          else code = k % 3 === 0 ? C('-') : (k + dc) % 2 ? C('X') : C('|');
          grid.put(r * grid.cols + c, code, MAST_PK, 0.9, 2);
        }
      }
      // A red beacon blinking on top: a light source of its own.
      const on = (env.time % 1.6) < 0.5;
      const i = grid.cellAt(mast.c * grid.cw + grid.cw / 2, (top - 1) * grid.ch + grid.ch / 2);
      if (i >= 0) grid.put(i, on ? C('*') : C('.'), pack(on ? BEACON : [110, 40, 40]), on ? 1 : 0.6, 6);
      if (on) grid.addLight(mast.c * grid.cw + grid.cw / 2, (top - 1) * grid.ch, 70, 0.55, BEACON);
    }
    const mastTop = () => [mast.c * grid.cw + grid.cw / 2, (mast.base - mast.height) * grid.ch];

    /* --- mist, leaves, rain, distant bolts, the lamp ---------------------- */

    function drawMist() {
      const t = env.time;
      for (let r = hzRow - 3; r <= hzRow + 2; r++) {
        if (r < 0 || r >= grid.rows) continue;
        const band = 1 - Math.abs(r - hzRow + 0.5) / 3.5;
        for (let c = 0; c < grid.cols; c++) {
          const n = noise(c * 0.05 - t * (0.4 + env.wind * 1.2), r * 0.7, 91);
          if (n < 0.56) continue;
          grid.put(r * grid.cols + c, n > 0.7 ? 126 : 45, MIST_PK, (n - 0.5) * 0.7 * band, 1);
        }
      }
    }

    function drawLeaves(dt) {
      // Strong gusts carry leaves and grit across the field.
      if (Math.abs(s.gust) > 0.35 && s.leaves.length < 40 && Math.random() < dt * 14 * Math.abs(s.gust)) {
        const dir = Math.sign(env.wind) || 1;
        s.leaves.push({ x: dir > 0 ? -10 : w + 10, y: rand(h * 0.35, h * 0.98), vy: rand(-30, 30), seed: rand(0, 6), pk: LEAF_PKS[Math.floor(Math.random() * 3)] });
      }
      const vx = env.wind * 1000;
      s.leaves = s.leaves.filter((l) => l.x > -20 && l.x < w + 20 && l.y > -20 && l.y < h + 20);
      for (const l of s.leaves) {
        l.x += vx * dt * (0.8 + 0.4 * Math.sin(l.seed));
        l.y += (l.vy + Math.sin(env.time * 6 + l.seed) * 60) * dt;
        const i = grid.cellAt(l.x, l.y);
        const spin = Math.floor(env.time * 10 + l.seed) % 4;
        if (i >= 0) grid.put(i, [C(','), C('`'), C("'"), C('.')][spin], l.pk, 0.8, 3);
      }
    }

    function drawRain() {
      for (const d of env.drops) {
        if (d.kind !== 'rain') continue;
        const i = grid.cellAt(d.x, d.y);
        if (i >= 0) grid.put(i, strokeGlyph(d.vx, d.vy), RAIN_PK, 0.26 + 0.4 * d.depth, 3);
      }
      for (const sp of env.splashes) {
        const age = env.time - sp.born;
        const i = grid.cellAt(sp.x, sp.y);
        if (i < 0) continue;
        grid.put(i, age < 0.12 ? 46 : 111, RAIN_PK, 0.5 * (1 - age / 0.3), 2);
        // Near drops leave a little ring in the puddles.
        if (sp.depth > 0.55 && age > 0.08) {
          const a = 0.35 * (1 - age / 0.3);
          if (i % grid.cols > 0) grid.put(i - 1, 40, RAIN_PK, a, 2);
          if (i % grid.cols < grid.cols - 1) grid.put(i + 1, 41, RAIN_PK, a, 2);
        }
      }
      for (const b of env.bolts) { // the module's own far-off bolts: pale, thin
        const fade = 1 - (env.time - b.born) / 0.35;
        for (let i = 1; i < b.pts.length; i++) grid.stroke(b.pts[i - 1][0], b.pts[i - 1][1], b.pts[i][0], b.pts[i][1], SKY_FLASH_PK, 0.55 * fade, 4);
        const last = b.pts[b.pts.length - 1];
        grid.addLight(last[0], last[1], 190, 0.3 * fade, [150, 170, 255]);
      }
    }

    function drawLamp(dt) {
      if (s.tx > -900) {
        if (s.cx < -900) { s.cx = s.tx; s.cy = s.ty; }
        const k = Math.min(1, dt * 14);
        s.cx += (s.tx - s.cx) * k;
        s.cy += (s.ty - s.cy) * k;
        grid.addLight(s.cx, s.cy, 120, 0.4, LAMP);
      } else s.cx = -999;
    }

    /* --- the intro: the Ship It bolt, struck in glyphs --------------------- */

    // The mark's bolt, as a polygon in its 64 x 64 box (same path as the logo).
    const MARK = [[37, 12.2], [12, 33.2], [14.2, 38], [24.4, 38], [21, 50.6], [26.6, 52], [44, 32], [43.2, 26], [33.6, 26], [37.8, 15]];
    function inMark(x, y) {
      let inside = false;
      for (let i = 0, j = MARK.length - 1; i < MARK.length; j = i++) {
        const [xi, yi] = MARK[i], [xj, yj] = MARK[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }

    // Lay the bolt onto the grid: every cell inside it, rim cells drawn as the
    // stroke that follows the edge, body cells from the density ramp.
    function buildLogo() {
      const size = Math.min(h * 0.46, w * 0.62); // px for the 40-unit-tall bolt
      const k = size / 40;
      const ox = w / 2 - 28 * k, oy = h * 0.44 - 32 * k;
      const at = (c, r) => inMark(((c + 0.5) * grid.cw - ox) / k, ((r + 0.5) * grid.ch - oy) / k);
      const c0 = Math.max(0, Math.floor((ox + 12 * k) / grid.cw) - 1), c1 = Math.min(grid.cols - 1, Math.ceil((ox + 44 * k) / grid.cw) + 1);
      const r0 = Math.max(0, Math.floor((oy + 12 * k) / grid.ch) - 1), r1 = Math.min(grid.rows - 1, Math.ceil((oy + 52 * k) / grid.ch) + 1);
      const cells = [];
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (!at(c, r)) continue;
          const nx = (at(c + 1, r) ? 1 : 0) - (at(c - 1, r) ? 1 : 0);
          const ny = (at(c, r + 1) ? 1 : 0) - (at(c, r - 1) ? 1 : 0);
          const rim = nx !== 0 || ny !== 0 || !at(c + 1, r + 1) || !at(c - 1, r - 1) || !at(c + 1, r - 1) || !at(c - 1, r + 1);
          cells.push({
            c, r, rim, x: (c + 0.5) * grid.cw, y: (r + 0.5) * grid.ch,
            code: rim ? strokeGlyph(-ny || 0.001, nx) : 0,
            n: hash(c, r, 41), vx: 0, vy: 0,
          });
        }
      }
      const rgb = strikeColour();
      return {
        cells, rgb, pk: pack(rgb), hot: pack(towardWhite(rgb, 0.75)),
        body: [0.25, 0.45, 0.65].map((t) => pack(towardWhite(rgb, t))),
        top: oy + 12 * k, bottom: oy + 52 * k, cx: w / 2, cy: h * 0.44, tipX: ox + 37.8 * k, tipY: oy + 13 * k,
      };
    }

    function drawLogo(t, dt) {
      const L = s.intro.logo;
      const since = t - INTRO.strike;
      if (since < 0 || !L) return;
      const build = clamp(since / 0.2, 0, 1); // it lands top to bottom in a fifth of a second
      const span = L.bottom - L.top;
      const breaking = t >= INTRO.breakAt;
      const life = breaking ? 1 - (t - INTRO.breakAt) / (INTRO.end - INTRO.breakAt) : 1;
      if (life <= 0) return;
      for (const cell of L.cells) {
        if ((cell.y - L.top) / span > build + cell.n * 0.08) continue;
        if (breaking) {
          // The bolt gives itself back to the storm: every glyph falls as rain.
          if (!cell.vy) { cell.vy = rand(180, 520); cell.vx = env.wind * 200 + rand(-50, 50); }
          cell.vy += 900 * dt;
          cell.x += cell.vx * dt;
          cell.y += cell.vy * dt;
          const i = grid.cellAt(cell.x, cell.y);
          if (i >= 0) grid.put(i, strokeGlyph(cell.vx, cell.vy), cell.rim ? L.pk : RAIN_PK, life * (cell.rim ? 0.9 : 0.6), 7);
          continue;
        }
        const i = cell.r * grid.cols + cell.c;
        if (cell.rim) {
          grid.put(i, cell.code, L.hot, 1, 7);
        } else {
          // The body shimmers by swapping glyphs, never by moving.
          const sh = noise(cell.c * 0.35, cell.r * 0.5 + t * 3, 17);
          grid.put(i, grid.ramp(clamp(5 + Math.round(sh * 4), 5, 9), i), L.body[Math.min(2, Math.floor(sh * 3))], 0.72 + 0.28 * sh, 7);
        }
      }
      // Its light: two quick flashes, then a steady afterglow that fades as it breaks.
      const f = since < 0.07 ? 1 : since < 0.15 ? 0.4 : since < 0.3 ? 1 : 0.55 + 0.1 * Math.sin(t * 9);
      grid.addLight(L.cx, L.cy, Math.max(w, h) * 0.55, f * 0.7 * life, L.rgb);
    }

    function stepIntro(dt) {
      const it = s.intro;
      it.t += dt;
      const t = it.t;
      // The storm decodes in from the top while the dark waits for the strike.
      grid.reveal = clamp((t - 0.25) / 1.4, 0, 1);
      if (!it.struck && t >= INTRO.strike) {
        it.struck = true;
        it.logo = buildLogo();
        // The real strike comes down out of the cloud onto the bolt's top tip.
        strike(it.logo.tipX, it.logo.tipY, true);
        const b = s.strikes[s.strikes.length - 1];
        Object.assign(b, { rgb: it.logo.rgb, pk: it.logo.pk, hot: it.logo.hot });
      }
      if (introMark && t >= INTRO.type) {
        // The name types in under the bolt, one letter per frame-ish.
        const name = 'ship it studio';
        const n = Math.min(name.length, Math.floor((t - INTRO.type) / 0.045));
        if (introMark.textContent.length !== n) introMark.textContent = name.slice(0, n);
        if (it.logo) introMark.style.top = Math.round(it.logo.bottom + 28) + 'px';
      }
      if (!it.shown && t >= INTRO.show) { it.shown = true; introDone(); }
      if (t >= INTRO.end) s.intro = null;
    }

    function skipIntro() {
      const it = s.intro;
      if (!it) return;
      if (!it.struck) { it.t = INTRO.strike; grid.reveal = 1; }
      else if (it.t < INTRO.breakAt) it.t = INTRO.breakAt;
    }

    /* --- the frame -------------------------------------------------------- */

    function dimBoxes() {
      if (root.classList.contains('intro')) return []; // nothing to read yet
      return Array.from(document.querySelectorAll('[data-dim], .frame'), (el) => el.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < h);
    }

    function paint(dt) {
      grid.clear();
      grid.refreshGround(groundAt, 0.1);
      drawMist();
      drawTrees();
      drawMast();
      drawRain();
      drawLeaves(dt);
      const sheet = drawSheets(dt);
      const peak = drawStrikes();
      if (s.intro) drawLogo(s.intro.t, dt);
      drawLamp(dt);
      grid.setDimBoxes(dimBoxes());
      grid.flash = Math.max(env.flash * 0.5, peak * 0.22, sheet);
      grid.draw();
    }

    function frame(now) {
      if (!s.running) return;
      s.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - s.last) / 1000 || 0.016);
      s.last = now;
      stepWind(dt);
      env.step(dt, w, h, hz);
      if (s.intro) stepIntro(dt);
      else if (grid.reveal < 1) grid.reveal = Math.min(1, grid.reveal + dt / 1.6);
      s.nextStrike -= dt;
      if (s.nextStrike <= 0) { // rare on its own; clicks are the point
        s.nextStrike = rand(14, 22);
        if (mast && Math.random() < 0.35) strike(...mastTop());
        else strike(rand(w * 0.08, w * 0.92), rand(hz + 6, hz + (h - hz) * 0.7));
      }
      paint(dt);
    }

    function renderStill() {
      grid.reveal = 1;
      for (let i = 0; i < 90; i++) env.step(0.02, w, h, hz);
      s.strikes = [];
      s.sheets = [];
      paint(0.016);
    }

    function start() {
      if (reduced || s.running || document.hidden) return;
      s.running = true;
      s.last = performance.now();
      s.raf = requestAnimationFrame(frame);
    }
    function stop() { s.running = false; cancelAnimationFrame(s.raf); }

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      s.tx = e.clientX; s.ty = e.clientY;
    }, { passive: true });
    document.addEventListener('pointerleave', () => { s.tx = -999; });
    window.addEventListener('keydown', skipIntro);
    window.addEventListener('wheel', skipIntro, { passive: true });
    window.addEventListener('pointerdown', (e) => {
      if (s.intro) { skipIntro(); return; }
      if (reduced || e.button !== 0 || e.target.closest(UI)) return;
      // A click near the mast's tip strikes the mast.
      const [mx, my] = mast ? mastTop() : [-1e9, -1e9];
      if (Math.hypot(e.clientX - mx, e.clientY - my) < 40) strike(mx, my);
      else strike(e.clientX, e.clientY);
      if (s.nextStrike < 8) s.nextStrike = 8; // don't stack a natural one on a click
    });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

    let lastW = window.innerWidth, lastH = window.innerHeight, timer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Mobile address bars change the height a little on scroll: ignore those.
        if (window.innerWidth === lastW && Math.abs(window.innerHeight - lastH) < 120) return;
        lastW = window.innerWidth; lastH = window.innerHeight;
        resize();
      }, 120);
    });

    resize();
    if (reduced) renderStill();
    else { grid.reveal = 0; start(); }
  }

  const ready = document.fonts && document.fonts.load ? document.fonts.load('400 12px "JetBrains Mono"') : Promise.resolve();
  Promise.resolve(ready).catch(() => {}).then(mount);
})();
