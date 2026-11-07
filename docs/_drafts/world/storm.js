/*
 * storm.js: Ship It's world. A night storm over low, rain-swept land.
 * The amber strike (shaped like the Ship It bolt) is the light source: for a
 * moment it lights every glyph; bloom is only drawn around the bolt itself.
 * Built on the shared engine (Grid) and weather module (rain). Exposes
 * window.ShipItStorm = { mount(canvas, opts) }.
 */
(function () {
  'use strict';

  const { clamp, rand, lerp, smoothstep, noise, hash, pack, mix, gradient } = window.AsciiEngine;
  const { Environment } = window.AsciiWeather;

  const FAMILY = '"JetBrains Mono", ui-monospace, Consolas, monospace';
  const AMBER = [255, 176, 32];
  const BOLT_CORE = pack([255, 236, 184]);
  const BOLT_HALO = pack(AMBER);
  const RAIN = pack([92, 116, 160]);
  const SWEPT = Array.from("-~_,'.:\"", (c) => c.charCodeAt(0));
  const RIM = Array.from('.,-~', (c) => c.charCodeAt(0));

  // How lit the world is, by seconds since a strike: a hard flash, a stutter, a second hit, a long decay.
  const lightAt = (a) => (a < 0.07 ? 1 : a < 0.13 ? 0.3 : a < 0.24 ? 1 : Math.exp(-(a - 0.24) * 3.2));
  // How visible the bolt itself is.
  const boltAt = (a) => (a < 0.3 ? 1 : a < 0.5 ? 1 - (a - 0.3) / 0.2 : 0);

  class Storm {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.opts = opts || {};
      this.reduced = !!this.opts.reduced;
      this.g = new window.AsciiEngine.Grid(canvas, FAMILY);
      this.g.reveal = 0; // nothing drawn until start() / the boot intro hands over
      this.env = new Environment();
      this.env.setHour(23); // the world is always night
      this.env.setWeather('rain');
      this.env.override('wet', 0.62);
      this.env.override('cloud', 1);
      this.env.setWind(0.3);
      this.env.wet = 0.62; // heavy rain, 500 drops or so
      this.env.cloud = 1;
      this.time = 0;
      this.strikes = [];
      this.nextAuto = 2.5;
      this.interval = 8;
      this.callAt = -9;
      this.pointer = { x: -999, y: -999, sx: -999, sy: -999, active: false };
      this.revealRate = 0;
      this.lowRate = false;
      this.skipNext = false;
      this.cost = 0;
      this.hzRow = 0;
      this.ridges = [];
      this.groundFn = this.makeGround();
      this.bind();
      this.resize();
    }

    /* ------------------------------------------------------------ setup */

    bind() {
      this.onMove = (e) => {
        const p = this.pointer;
        p.x = e.clientX;
        p.y = e.clientY;
        p.active = e.pointerType !== 'touch';
        if (p.sx < -900) {
          p.sx = p.x;
          p.sy = p.y;
        }
      };
      this.onLeave = () => (this.pointer.active = false);
      window.addEventListener('pointermove', this.onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', this.onLeave);
      window.addEventListener('blur', this.onLeave);
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.canvas);
      this.frame = (now) => {
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        this.update(dt);
        // Below the fold the veil hides most of it: paint at half rate. Slow machines do the same.
        if (!this.skipNext) {
          const t0 = performance.now();
          this.paint();
          this.cost = lerp(this.cost, performance.now() - t0, 0.1);
        }
        this.skipNext = (this.cost > 12 || this.lowRate) && !this.skipNext;
        this.raf = requestAnimationFrame(this.frame);
      };
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const g = this.g;
      const px = clamp(Math.round(r.width / 230), 6, 8); // fine glyphs: more cells, more detail
      g.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, 2), px);
      this.hzRow = Math.round(g.rows * 0.64);
      this.hz = this.hzRow * g.ch;
      // Ridge tops per layer (far to near): rows above the horizon where each silhouette starts.
      const amp = [g.rows * 0.075, g.rows * 0.05, g.rows * 0.028];
      this.ridges = amp.map((a, k) => {
        const top = new Int16Array(g.cols);
        for (let c = 0; c < g.cols; c++) {
          const n = 0.6 * noise(c * 0.017 + k * 40, k * 7, 11) + 0.4 * noise(c * 0.06 + k * 9, k * 3, 12);
          top[c] = Math.round(this.hzRow - 1 - a * (0.15 + 0.85 * n));
        }
        return top;
      });
      if (this.reduced) this.drawStill();
    }

    // Fade the scene behind the given boxes (viewport px) so text stays readable.
    setAvoid(boxes) {
      this.g.setDimBoxes(boxes);
      if (this.reduced && this.g.cols) this.paint();
    }

    start() {
      if (this.reduced) return this.drawStill();
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }

    // Decode the world in from the top over `seconds`.
    reveal(seconds) {
      if (this.reduced) return;
      this.g.reveal = 0;
      this.revealRate = 1 / seconds;
      this.nextAuto = Math.max(this.nextAuto, 1.6);
    }

    /* ------------------------------------------------------------ world */

    // The ground layer: sky and cloud, three ridges, wet swept land. Refreshed a few rows a frame.
    makeGround() {
      return (i, c, r) => {
        const g = this.g, hzRow = this.hzRow, t = this.time;
        let code = 0, col = 0, a = 0;
        if (r < hzRow) {
          let k = -1;
          for (let q = 2; q >= 0; q--) if (r >= this.ridges[q][c]) { k = q; break; }
          if (k >= 0) {
            // ridge silhouette: darker the nearer it is, a faint rim along the top
            const dr = r - this.ridges[k][c];
            const tex = noise(c * 0.3, r * 0.5, 40 + k);
            if (dr < 1) {
              code = RIM[(hash(c, r, 6) * 4) | 0];
              col = pack(mix([120, 142, 184], [72, 90, 126], k / 2));
              a = 0.75;
            } else {
              code = g.ramp(Math.min(8, 3 + Math.floor(tex * 4) + (k === 0 ? 0 : 1)), i);
              col = pack(k === 0 ? [54, 70, 106] : k === 1 ? [38, 50, 80] : [26, 35, 58]);
              a = 0.55 + 0.1 * k + 0.15 * tex;
            }
          } else {
            // heavy cloud drifting slowly
            const y = r / hzRow, x = (c + t * 1.1) * 0.05;
            const n = 0.55 * noise(x, r * 0.17, 5) + 0.3 * noise(x * 2.3 + 7, r * 0.42, 9) + 0.15 * noise(x * 5, r * 0.9, 13);
            const d = smoothstep(0.3, 0.72, n) * (0.55 + 0.45 * this.env.cloud);
            if (d < 0.05) {
              // gap in the cloud: a thin haze so the sky is never empty
              // thicker, paler mist toward the horizon: the ridges stand against it
              const mist = smoothstep(0.5, 1, y);
              if (hash(c, r, 3) < 0.22 + 0.3 * y + 0.5 * mist) {
                code = g.ramp(1 + Math.floor(mist * 3 * hash(c, r, 9)), i);
                col = pack(mix([44, 58, 90], [104, 126, 170], mist));
                a = 0.2 + 0.18 * y + 0.3 * mist;
              }
            } else {
              code = g.ramp(Math.min(8, 1 + Math.floor(d * 7.5)), i);
              col = pack(gradient([[26, 34, 56], [46, 60, 92], [82, 98, 138]], d));
              a = 0.2 + 0.5 * d;
            }
            if (y > 0.86 && hash(c, r, 8) < 0.5) {
              // rain haze along the horizon
              code = 126;
              col = pack([70, 88, 122]);
              a = Math.max(a, 0.3);
            }
          }
        } else {
          // wet land, swept sideways by the wind; calm puddles that catch the light
          const dn = (r - hzRow) / Math.max(1, g.rows - hzRow);
          const sx = (c + t * (5 + 9 * dn)) * (0.03 + 0.02 * (1 - dn));
          const n = 0.65 * noise(sx, r * 0.55, 21) + 0.35 * noise(sx * 3.1, r * 1.3, 23);
          if (noise(c * 0.022, r * 0.09, 33) > 0.64 + 0.1 * (1 - dn)) {
            code = hash(c, r, 4) < 0.5 ? 61 : 45;
            col = pack(mix([62, 86, 126], [110, 140, 190], n));
            a = 0.5 + 0.3 * dn;
          } else {
            // a mix of dense ramp glyphs and swept punctuation, denser toward the viewer
            code = hash(c, r, 2) < 0.35 ? SWEPT[Math.min(7, Math.floor(n * 10))] || 45 : g.ramp(Math.min(7, 1 + Math.floor(n * 3 + dn * 3.5)), i);
            col = pack(gradient([[46, 64, 96], [70, 96, 136], [104, 134, 178]], dn * 0.7 + n * 0.3));
            a = 0.42 + 0.3 * dn + 0.22 * n;
            // wet ground near the horizon mirrors the pale mist
            const sheen = 1 - smoothstep(0, 0.22, dn);
            if (sheen > 0) {
              col = pack(mix([46, 64, 96], [110, 132, 176], sheen * (0.5 + 0.5 * n)));
              a = Math.max(a, 0.35 + 0.4 * sheen);
            }
          }
        }
        g.gGlyph[i] = code;
        g.gColor[i] = col;
        g.gAlpha[i] = Math.min(1, a * 1.3);
      };
    }

    /* ------------------------------------------------------------ strikes */

    // The Ship It bolt: down-left from the top, a short jog right at the middle, down-left to the tip.
    // Jagged forks leave it. Returns the strike; `yEnd` is where it lands (viewport px).
    strike(x, yEnd, called) {
      const L = Math.max(220, yEnd);
      const s = clamp(L * 0.17, 46, 150);
      const key = [[x + 0.62 * s, -8], [x - 0.32 * s, L * 0.5], [x + 0.38 * s, L * 0.5], [x - 0.55 * s, L]];
      const trunk = [];
      // each leg broken into jittered pieces so it crackles but keeps the icon's silhouette
      for (let leg = 0; leg < 3; leg++) {
        const [x0, y0] = key[leg], [x1, y1] = key[leg + 1];
        const n = leg === 1 ? 1 : 6;
        for (let q = 0; q < n; q++) {
          const f0 = q / n, f1 = (q + 1) / n;
          const j0 = q === 0 ? 0 : rand(-0.06, 0.06) * s, j1 = q === n - 1 ? 0 : rand(-0.06, 0.06) * s;
          trunk.push({ p: [lerp(x0, x1, f0) + j0, lerp(y0, y1, f0)], q: [lerp(x0, x1, f1) + j1, lerp(y0, y1, f1)] });
        }
      }
      // fix joints so legs meet exactly where the previous piece ended
      for (let k = 1; k < trunk.length; k++) trunk[k].p = trunk[k - 1].q;
      const forks = [];
      for (let f = 0; f < 2; f++) {
        const seg = trunk[Math.floor(rand(1, trunk.length - 2))];
        const dir = Math.random() < 0.5 ? -1 : 1;
        let [px, py] = seg.q;
        const pts = [[px, py]];
        for (let q = 0; q < 6; q++) {
          px += dir * rand(6, 22);
          py += rand(14, 30);
          pts.push([px, py]);
        }
        forks.push(pts);
      }
      const st = { born: this.time, x, y: yEnd, tip: key[3], trunk, forks, L, called: !!called };
      this.strikes.push(st);
      if (this.opts.onStrike) this.opts.onStrike(st);
      return st;
    }

    // A strike the visitor calls: lands where they clicked.
    call(x, y) {
      if (this.reduced || this.time - this.callAt < 0.5) return null;
      this.callAt = this.time;
      return this.strike(x, clamp(y, this.hz * 0.8, this.g.h), true);
    }

    // The natural strike still fresh enough to catch with a click, if any.
    catchable() {
      return this.strikes.find((s) => !s.called && this.time - s.born < 0.75) || null;
    }

    get charge() {
      return clamp(1 - this.nextAuto / this.interval, 0, 1);
    }

    /* ------------------------------------------------------------ frame */

    update(dt) {
      this.time += dt;
      const g = this.g;
      this.env.step(dt, g.w, g.h, this.hz);
      if (this.revealRate && g.reveal < 1) g.reveal = Math.min(1, g.reveal + dt * this.revealRate);
      if (g.reveal > 0.15) {
        this.nextAuto -= dt;
        if (this.nextAuto <= 0) {
          this.interval = rand(6, 12);
          this.nextAuto = this.interval;
          const x = g.w * rand(0.12, 0.88);
          this.strike(x, this.hz + rand(10, (g.h - this.hz) * 0.7), false);
        }
      }
      this.strikes = this.strikes.filter((s) => this.time - s.born < 1.9);
      const p = this.pointer;
      p.sx += (p.x - p.sx) * Math.min(1, dt * 14);
      p.sy += (p.y - p.sy) * Math.min(1, dt * 14);
    }

    // The strike lights the whole glyph world. Per-cell lights would restyle every cell of the
    // screen, so it is a compositing pass instead: a warm copy of the finished frame, faded out
    // away from the bolt, added back on top. Only the bolt itself gets a bloom disc.
    lightWorld(s, E) {
      const g = this.g, cvs = g.ctx.canvas, ctx = g.ctx;
      if (!this.tmp || this.tmp.width !== cvs.width || this.tmp.height !== cvs.height) {
        this.tmp = document.createElement('canvas');
        this.tmp.width = cvs.width;
        this.tmp.height = cvs.height;
        this.tctx = this.tmp.getContext('2d');
      }
      const t = this.tctx, d = g.dpr, W = cvs.width, H = cvs.height;
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalCompositeOperation = 'copy';
      t.drawImage(cvs, 0, 0);
      t.globalCompositeOperation = 'source-atop';
      t.fillStyle = 'rgba(255,176,32,0.5)';
      t.fillRect(0, 0, W, H);
      t.globalCompositeOperation = 'destination-in';
      const cx = s.tip[0] * d, cy = s.L * 0.55 * d, r = Math.max(W, H) * 1.05;
      const grad = t.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0.28)');
      t.fillStyle = grad;
      t.fillRect(0, 0, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(E, 0, 1);
      ctx.drawImage(this.tmp, 0, 0);
      if (E > 0.6) ctx.drawImage(this.tmp, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }

    paint() {
      const g = this.g;
      if (!g.cols) return;
      g.clear();
      g.flash = 0;
      g.refreshGround(this.groundFn, 0.2);
      this.paintRain();
      for (const s of this.strikes) this.paintStrike(s);
      this.paintCursor();
      g.draw();
      if (g.reveal >= 1) for (const s of this.strikes) if (s.E > 0.04) this.lightWorld(s, s.E);
    }

    paintRain() {
      const g = this.g, env = this.env, hz = this.hz;
      for (const d of env.drops) {
        const i = g.cellAt(d.x, d.y);
        if (i < 0) continue;
        const a = 0.12 + 0.3 * d.depth;
        g.put(i, 124, RAIN, a, 2);
        const up = i - g.cols;
        if (up >= 0) g.put(up, 124, RAIN, a * 0.5, 2);
      }
      for (const s of env.splashes) {
        if (s.y < hz) continue;
        const age = env.time - s.born, i = g.cellAt(s.x, s.y);
        if (i < 0) continue;
        g.put(i, age < 0.1 ? 58 : age < 0.2 ? 46 : 44, RAIN, 0.5 * (1 - age / 0.3), 2);
      }
    }

    // Thick polyline piece: `th` strokes side by side, tapering toward the tip.
    thick(p, q, th, rgb, alpha, z) {
      const g = this.g, off = [[0], [-0.5, 0.5], [-1, 0, 1]][th - 1];
      for (const o of off) g.stroke(p[0] + o * g.cw, p[1], q[0] + o * g.cw, q[1], rgb, alpha, z);
    }

    paintStrike(s) {
      const g = this.g, age = this.time - s.born;
      const E = this.frozen ? lightAt(0.26) : lightAt(age);
      const vis = boltAt(age) * (age >= 0.07 && age < 0.13 ? 0.35 : 1);
      s.E = E;
      if (vis < 0.02) return;
      // the bolt, haloed; bloom only here
      for (const seg of s.trunk) {
        const f = (seg.q[1] / s.L), th = f < 0.62 ? 3 : f < 0.86 ? 2 : 1;
        this.thick(seg.p, seg.q, th, BOLT_HALO, 0.38 * vis, 5);
        this.thick([seg.p[0] - 2.2 * g.cw, seg.p[1]], [seg.q[0] - 2.2 * g.cw, seg.q[1]], 1, BOLT_HALO, 0.3 * vis, 4);
        this.thick([seg.p[0] + 2.2 * g.cw, seg.p[1]], [seg.q[0] + 2.2 * g.cw, seg.q[1]], 1, BOLT_HALO, 0.3 * vis, 4);
        this.thick(seg.p, seg.q, th, BOLT_CORE, vis, 6);
      }
      for (const pts of s.forks) {
        for (let k = 0; k + 1 < pts.length; k++) g.stroke(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], BOLT_HALO, 0.75 * vis * (1 - k / 8), 5);
      }
      for (const q of [0.12, 0.36, 0.6, 0.84]) {
        const seg = s.trunk[Math.min(s.trunk.length - 1, Math.floor(q * s.trunk.length))];
        g.addLight(seg.q[0], seg.q[1], 70 + s.L * 0.1, 0.9 * E * vis, AMBER);
      }
      // impact: a few sparks where it lands
      if (age < 0.35) {
        for (let k = 0; k < 7; k++) {
          const ang = (k / 7) * Math.PI * 2 + s.born, rr = (6 + age * 90) * (0.6 + hash(k, 5, 1));
          const i = g.cellAt(s.tip[0] + Math.cos(ang) * rr * 1.6, s.y + Math.sin(ang) * rr * 0.5);
          if (i >= 0) g.put(i, k % 2 ? 42 : 43, BOLT_CORE, 0.9 * (1 - age / 0.35), 6);
        }
      }
    }

    // A small amber light at the cursor, with a tiny reticle.
    paintCursor() {
      const p = this.pointer, g = this.g;
      if (!p.active) return;
      g.addLight(p.sx, p.sy, 90, 0.6, AMBER);
      const i = g.cellAt(p.sx, p.sy);
      if (i >= 0) g.put(i, 43, pack(AMBER), 0.95, 7);
    }

    // Reduced motion: one still frame, mid-strike, rain already falling.
    drawStill() {
      if (!this.g.cols) return;
      this.frozen = true;
      this.g.reveal = 1;
      if (this.time < 3) for (let k = 0; k < 200; k++) this.update(1 / 60);
      if (!this.strikes.length) {
        const st = this.strike(this.g.w * 0.68, this.hz + (this.g.h - this.hz) * 0.45, false);
        st.born = Infinity; // pinned: the frozen light is evaluated directly
      }
      for (const s of this.strikes) s.born = this.time - 0.26;
      this.paint();
    }
  }

  window.ShipItStorm = { mount: (canvas, opts) => (window.ShipItStorm.instance = new Storm(canvas, opts)) };
})();
