/*
 * exhibit / scene: "The Storm".
 * A night sky of heavy glyph clouds over a wet plain, rain and distant
 * lightning from the shared weather module, and the Ship It bolt struck in
 * amber glyphs as the one light that lights the wall. It strikes on its own
 * every so often; a click strikes where you point; the cursor is a small lamp.
 *
 * window.ShipStorm.mount(canvas, { avoid, reduced, onFound }) -> { resize }
 *   avoid():   DOM rects the scene should dim behind (the placard, the chrome)
 *   reduced:   one still frame, no motion
 *   onFound(): called once when the small hidden glyph on the plain is caught
 */
(function () {
  'use strict';

  const { clamp, rand, smoothstep, noise, pack, strokeGlyph, Grid } = window.AsciiEngine;
  const { Environment } = window.AsciiWeather;

  const FAMILY = '"JetBrains Mono", ui-monospace, Consolas, monospace';
  const AMBER = [255, 176, 32];
  const AMBER_PK = pack(AMBER);
  const HOT_PK = pack([255, 226, 150]);
  const RAIN_PK = pack([128, 150, 205]);
  const SKY_FLASH_PK = pack([190, 205, 255]);
  const BOLT_LIFE = 1.7;

  function mount(canvas, opts) {
    opts = opts || {};
    const grid = new Grid(canvas, FAMILY);
    const env = new Environment();
    env.setHour(23);
    env.setWeather('storm');
    Object.assign(env, { cloud: 1, wet: 1, storm: 1, fog: 0, snow: 0 });

    let w = 0, h = 0, hz = 0, hzRow = 0, dpr = 1;
    let marker = { x: 0, y: 0 };
    const s = {
      cx: -999, cy: -999, tx: -999, ty: -999, // cursor lamp, eased
      strikes: [], nextStrike: 2.4, dwell: 0, found: false,
      running: false, raf: 0, last: 0, frameNo: 0,
    };

    /* --- layout ---------------------------------------------------- */

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      grid.resize(w, h, dpr, w < 600 ? 6 : 7);
      hzRow = Math.round((h * 0.6) / grid.ch);
      hz = hzRow * grid.ch;
      marker = { x: w * 0.8, y: hz + (h - hz) * 0.36 };
      if (opts.reduced) renderStill();
    }

    /* --- the ground layer: clouds, ridge, wet plain, the long ruler -- */

    function groundAt(i, c, r) {
      const t = env.time;
      if (r < hzRow) {
        const sky = r / hzRow; // 0 at the top, 1 at the horizon
        // A low silhouette of distant hills along the horizon.
        const ridge = hzRow - 2 - Math.floor(4 * noise(c * 0.035, 3, 9) + 2 * noise(c * 0.14, 8, 3));
        if (r >= ridge) {
          grid.gGlyph[i] = grid.ramp(6, i);
          grid.gColor[i] = pack([26, 33, 54]);
          grid.gAlpha[i] = 0.95;
          return;
        }
        const drift = t * 0.45 + env.wind * t * 0.4;
        let n = noise(c * 0.045 + drift, r * 0.12, 11) * 0.62 + noise(c * 0.12 + drift * 1.7, r * 0.3, 23) * 0.38;
        n *= 1.18 - 0.4 * sky; // heaviest overhead
        const k = clamp(Math.round((n - 0.26) * 11), 0, 7);
        if (k <= 0) { grid.gGlyph[i] = 0; return; }
        grid.gGlyph[i] = grid.ramp(k, i);
        grid.gColor[i] = pack([62 + n * 52, 76 + n * 58, 112 + n * 66]);
        grid.gAlpha[i] = 0.4 + 0.48 * Math.min(1, k / 6);
        return;
      }
      const d = (r - hzRow) / Math.max(1, grid.rows - hzRow); // 0 far .. 1 near
      // The stream is long: one ruler of ticks runs the width of the plain.
      if (r === hzRow + 4) {
        const tick = c % 12 === 0;
        grid.gGlyph[i] = tick ? 124 : 46;
        grid.gColor[i] = pack([100, 116, 160]);
        grid.gAlpha[i] = tick ? 0.6 : 0.3;
        return;
      }
      // Wet ground: slow ripples of dashes and tildes.
      const n = noise(c * 0.17, r * 0.55 + t * 0.7, 5);
      if (n < 0.5) { grid.gGlyph[i] = 0; return; }
      grid.gGlyph[i] = n > 0.68 ? 126 : 45;
      grid.gColor[i] = pack([74, 96, 146]);
      grid.gAlpha[i] = 0.26 + 0.34 * d;
    }

    /* --- strikes ---------------------------------------------------- */

    // The Ship It bolt: a jagged zig from the cloud to (x, y), plus branches.
    function strike(x, y) {
      const gy = clamp(y, h * 0.34, h * 0.92);
      const pts = [[x, -8]];
      let px = x, py = -8, dir = Math.random() < 0.5 ? 1 : -1;
      while (py < gy) {
        py = Math.min(gy, py + rand(grid.ch * 2.2, grid.ch * 4.4));
        px += dir * rand(grid.cw * 2, grid.cw * 7);
        if (Math.random() < 0.7) dir = -dir;
        pts.push([px, py]);
      }
      // Pull the path so it lands exactly on (x, gy).
      const dx = x - px;
      for (const p of pts) p[0] += dx * ((p[1] + 8) / (gy + 8));
      const branches = [];
      for (let b = 0; b < 2; b++) {
        const at = 2 + Math.floor(Math.random() * Math.max(1, pts.length - 4));
        const bp = [pts[at].slice()];
        const side = Math.random() < 0.5 ? -1 : 1;
        for (let k = 0; k < 3; k++) {
          const last = bp[bp.length - 1];
          bp.push([last[0] + side * rand(grid.cw * 2, grid.cw * 6), last[1] + rand(grid.ch * 2, grid.ch * 3.5)]);
        }
        branches.push(bp);
      }
      s.strikes.push({ pts, branches, born: env.time, gx: x, gy });
      if (Math.hypot(x - marker.x, gy - marker.y) < 46) catchMarker();
    }

    function catchMarker() {
      if (s.found) return;
      s.found = true;
      if (opts.onFound) opts.onFound();
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
        const segs = [b.pts, ...b.branches];
        segs.forEach((line, n) => {
          for (let i = 1; i < line.length; i++) {
            const [x0, y0] = line[i - 1], [x1, y1] = line[i];
            const main = n === 0;
            grid.stroke(x0 + grid.cw, y0, x1 + grid.cw, y1, AMBER_PK, ink * (main ? 0.7 : 0.45), 5);
            grid.stroke(x0, y0, x1, y1, main ? HOT_PK : AMBER_PK, ink, 6);
          }
        });
        // Light along the bolt: a handful of lamps, and a big one where it lands.
        const step = Math.ceil(b.pts.length / 6);
        for (let i = 0; i < b.pts.length; i += step) grid.addLight(b.pts[i][0], b.pts[i][1], 250, f * 0.5, AMBER);
        grid.addLight(b.gx, b.gy, 380, f * 0.95, AMBER);
        // A ring of glyphs spreads over the plain where it lands.
        if (age < 0.9) {
          const rr = age * 240, fade = 1 - age / 0.9;
          for (let a = 0; a < 20; a++) {
            const ang = (a / 20) * Math.PI * 2;
            const i = grid.cellAt(b.gx + Math.cos(ang) * rr * 2, b.gy + Math.sin(ang) * rr * 0.34);
            if (i >= 0) grid.put(i, age < 0.3 ? 42 : 111, AMBER_PK, fade * 0.85, 5);
          }
        }
      }
      return peak;
    }

    /* --- rain, distant lightning, the lamp, the hidden glyph -------- */

    function drawRain() {
      for (const d of env.drops) {
        if (d.kind !== 'rain') continue;
        const i = grid.cellAt(d.x, d.y);
        if (i >= 0) grid.put(i, strokeGlyph(d.vx, d.vy), RAIN_PK, 0.26 + 0.4 * d.depth, 3);
      }
      for (const sp of env.splashes) {
        const age = env.time - sp.born;
        const i = grid.cellAt(sp.x, sp.y);
        if (i >= 0) grid.put(i, age < 0.12 ? 46 : 111, RAIN_PK, 0.5 * (1 - age / 0.3), 2);
      }
      // The module's own bolts are far off: pale, thin, no amber.
      for (const b of env.bolts) {
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
        grid.addLight(s.cx, s.cy, 130, 0.5, AMBER);
        const i = grid.cellAt(s.cx, s.cy);
        if (i >= 0) grid.put(i, 43, HOT_PK, 0.9, 7);
      } else s.cx = -999;
    }

    // A small glyph on the plain; hold the lamp over it, or strike it.
    function drawMarker(dt) {
      const dist = Math.hypot(s.cx - marker.x, s.cy - marker.y);
      s.dwell = clamp(s.dwell + (dist < 34 ? dt : -dt * 0.5), 0, 2);
      if (s.dwell > 0.6) catchMarker();
      const i = grid.cellAt(marker.x, marker.y);
      if (i < 0) return;
      grid.put(i, 42, AMBER_PK, s.found ? 1 : 0.15, 4);
      if (s.found) {
        grid.put(i - 2, 40, AMBER_PK, 0.9, 4);
        grid.put(i + 2, 41, AMBER_PK, 0.9, 4);
        grid.addLight(marker.x, marker.y, 90, 0.45, AMBER);
      }
    }

    /* --- the frame -------------------------------------------------- */

    function paint(dt) {
      grid.clear();
      grid.refreshGround(groundAt, 0.1);
      drawRain();
      drawMarker(dt);
      const peak = drawStrikes();
      drawLamp(dt);
      const rects = opts.avoid ? opts.avoid() : [];
      grid.setDimBoxes(rects.filter((r) => r.bottom > 0 && r.top < h));
      grid.flash = Math.max(env.flash * 0.5, peak * 0.3);
      grid.draw();
    }

    function frame(now) {
      if (!s.running) return;
      s.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - s.last) / 1000 || 0.016);
      s.last = now;
      env.step(dt, w, h, hz);
      if (grid.reveal < 1) grid.reveal = Math.min(1, grid.reveal + dt / 1.9);
      s.nextStrike -= dt;
      if (s.nextStrike <= 0) {
        s.nextStrike = rand(7, 11);
        strike(rand(w * 0.18, w * 0.82), rand(hz + 10, hz + (h - hz) * 0.6));
      }
      paint(dt);
    }

    function renderStill() {
      grid.reveal = 1;
      for (let i = 0; i < 90; i++) env.step(0.02, w, h, hz);
      s.strikes = [];
      strike(w * 0.62, hz + (h - hz) * 0.3);
      s.strikes[0].born = env.time - 0.25; // held at the peak of the flash
      paint(0.016);
    }

    function start() {
      if (opts.reduced || s.running) return;
      s.running = true;
      s.last = performance.now();
      s.raf = requestAnimationFrame(frame);
    }
    function stop() {
      s.running = false;
      cancelAnimationFrame(s.raf);
    }

    /* --- input + visibility ----------------------------------------- */

    function onScroll() {
      const y = window.scrollY / h;
      // The storm gives the wall back as you leave the first piece.
      canvas.style.opacity = String(1 - smoothstep(0.35, 1.05, y));
      if (y > 1.1 || document.hidden) stop();
      else start();
    }

    window.addEventListener('pointermove', (e) => { s.tx = e.clientX; s.ty = e.clientY; }, { passive: true });
    document.addEventListener('pointerleave', () => { s.tx = -999; });
    window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') s.tx = -999; }, { passive: true });
    window.addEventListener('pointerdown', (e) => {
      if (opts.reduced || window.scrollY > h * 0.8) return;
      if (e.target.closest('a, button, .placard, .chrome')) return;
      strike(e.clientX, e.clientY);
    });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onScroll);

    let lastW = 0, lastH = 0, timer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Mobile address bars change the height a little on scroll: ignore those.
        if (window.innerWidth === lastW && Math.abs(window.innerHeight - lastH) < 120) return;
        lastW = window.innerWidth; lastH = window.innerHeight;
        resize();
      }, 120);
    });

    lastW = window.innerWidth; lastH = window.innerHeight;
    resize();
    if (opts.reduced) renderStill();
    else {
      grid.reveal = 0;
      onScroll();
    }
    return { resize };
  }

  window.ShipStorm = { mount };
})();
