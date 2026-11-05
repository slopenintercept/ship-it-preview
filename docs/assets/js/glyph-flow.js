/* Ship It glyph backdrop for the web: a port of the Studio's own maths
   (studio_ui/src/screens/editor/character-flow.js + CharacterFlow.jsx) and of ASCII forward's bolt
   (flow.js), with two page-only additions: the pointer lifts the smoke under it, and scrolling /
   wheeling pushes the wind for a moment. Plain static-file JS: no build step, no network, no storage.

   <canvas data-flow="backdrop|well|bolt"> elements are found by scan().
   - backdrop: the one canvas fixed to the viewport behind the whole page. It draws the glyph smoke and,
     centred on top of it, ASCII forward's bolt (see Backdrop). The smoke clears a hole round the bolt.
   - well:     a small smoke canvas inside a panel (the monitor, the download card).
   - bolt:     the startup intro's bolt, struck in glyphs ("A look inside").
   Under prefers-reduced-motion every canvas is drawn once, as one finished still frame. */
(function () {
  'use strict';

  // If a 2d canvas cannot be made, the page falls back to the still bolt image (see the CSS).
  var CANVAS_OK = (function () {
    try { var c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d')); }
    catch (e) { return false; }
  })();
  if (!CANVAS_OK) document.documentElement.classList.add('no-canvas');

  var GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var FLOW = {
    cellW: 8, cellH: 16, fontPx: 10, windDeg: 35, speed: 58,
    streakLen: 520, streakWid: 150, warp: 0.45, threshold: 0.6, soft: 0.22,
    floor: 0.17, levels: 8, swapsPerSecond: 2
  };
  var WIND = (FLOW.windDeg * Math.PI) / 180;
  var COS = Math.cos(WIND);
  var SIN = Math.sin(WIND);

  function hash(x, y, salt) {
    var h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function smooth(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function valueNoise(x, y, salt) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = smooth(x - ix), fy = smooth(y - iy);
    var a = hash(ix, iy, salt), b = hash(ix + 1, iy, salt);
    var c = hash(ix, iy + 1, salt), d = hash(ix + 1, iy + 1, salt);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function smokeAt(px, py, t, seed) {
    var u = px * COS + py * SIN - FLOW.speed * t;
    var v = -px * SIN + py * COS;
    var nu = u / FLOW.streakLen;
    var vb = v / FLOW.streakWid + FLOW.warp * (valueNoise(nu * 0.7, 3.1, seed + 7) - 0.5) * 4;
    var big = valueNoise(nu, vb, seed);
    var fine = valueNoise(nu * 2.7 + 11, vb * 2.7, seed + 1);
    return big * 0.72 + fine * 0.28;
  }
  // boost: extra smoke added at this cell (the pointer's lift); 0 = the Studio exactly.
  function cellCode(cx, cy, t, seed, threshold, boost) {
    var px = (cx + 0.5) * FLOW.cellW, py = (cy + 0.5) * FLOW.cellH;
    var s = smokeAt(px, py, t, seed) + boost;
    if (s <= threshold) return 0;
    var b = Math.min(1, (s - threshold) / FLOW.soft);
    b = FLOW.floor + (1 - FLOW.floor) * b;
    b *= 0.85 + 0.15 * hash(cx, cy, seed + 3);
    var level = Math.max(1, Math.min(FLOW.levels, Math.ceil(b * FLOW.levels)));
    var phase = hash(cx, cy, seed + 5);
    var tick = Math.floor(t * FLOW.swapsPerSecond + phase * 8);
    var glyph = Math.floor(hash(cx * 7 + tick, cy * 13 - tick, seed + 9) * GLYPHS.length);
    return (level << 8) | glyph;
  }

  var reduceQuery = null;
  try { reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch (e) { reduceQuery = null; }
  function reduced() { return !!(reduceQuery && reduceQuery.matches); }

  function buildAtlas(ink, scale, minA, maxA) {
    var cw = Math.round(FLOW.cellW * scale), ch = Math.round(FLOW.cellH * scale);
    var sheet = document.createElement('canvas');
    sheet.width = cw * GLYPHS.length;
    sheet.height = ch * FLOW.levels;
    var g = sheet.getContext('2d');
    if (!g) return null;
    g.font = (FLOW.fontPx * scale) + 'px "Geist Mono", Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = ink;
    for (var l = 0; l < FLOW.levels; l++) {
      g.globalAlpha = minA + ((maxA - minA) * l) / (FLOW.levels - 1);
      for (var i = 0; i < GLYPHS.length; i++) g.fillText(GLYPHS[i], i * cw + cw / 2, l * ch + ch / 2);
    }
    return { sheet: sheet, cw: cw, ch: ch };
  }

  /* ── shared input: pointer + scroll/wheel nudge ─────────────────────── */
  var input = { x: -9999, y: -9999, active: false, boost: 0, started: false, tops: new Map() };
  function startInput() {
    if (input.started) return;
    input.started = true;
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      input.x = e.clientX; input.y = e.clientY; input.active = true;
    }, { passive: true });
    document.addEventListener('pointerleave', function () { input.active = false; }, { passive: true });
    window.addEventListener('wheel', function (e) {
      input.boost = Math.min(3, input.boost + Math.abs(e.deltaY) / 500);
    }, { passive: true });
    document.addEventListener('scroll', function (e) {
      var t = e.target;
      var top = (t === document || t === document.documentElement || t === document.body) ? (window.scrollY || 0) : (t.scrollTop || 0);
      var prev = input.tops.has(t) ? input.tops.get(t) : top;
      input.tops.set(t, top);
      input.boost = Math.min(3, input.boost + Math.abs(top - prev) / 500);
    }, { capture: true, passive: true });
  }

  /* ── the smoke in a panel ───────────────────────────────────────────── */
  function Smoke(canvas) {
    var d = canvas.dataset || {};
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.seed = parseInt(d.seed || '1', 10);
    this.ink = d.ink || '#E8EAEA';
    this.maxA = parseFloat(d.alphaMax || '0.2');
    this.minA = parseFloat(d.alphaMin || '0.06');
    this.threshold = parseFloat(d.threshold || '0.6');
    this.ground = d.ground || '';
    this.fps = parseInt(d.fps || '20', 10);
    this.react = d.react !== 'off';
    this.scale = Math.min(2, window.devicePixelRatio || 1);
    this.clock = 40;
    this.last = 0; this.lastDraw = 0; this.raf = 0;
    this.still = reduced();
    var self = this;
    this.atlas = buildAtlas(this.ink, this.scale, this.minA, this.maxA);
    if (!this.atlas || !this.ctx) return;
    if (document.fonts && document.fonts.load) {
      document.fonts.load(FLOW.fontPx + 'px "Geist Mono"').then(function () {
        self.atlas = buildAtlas(self.ink, self.scale, self.minA, self.maxA) || self.atlas;
        self.paint();
      }).catch(function () {});
    }
    this.size();
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(function () { self.size(); });
      this.ro.observe(canvas);
    }
    this.tick = function (now) {
      self.raf = requestAnimationFrame(self.tick);
      if (now - self.lastDraw < 1000 / self.fps - 1) return;
      var dt = self.last ? Math.min(0.25, (now - self.last) / 1000) : 0;
      self.clock += dt * (1 + input.boost * 2.2);
      input.boost *= 0.93;
      self.last = now; self.lastDraw = now;
      self.paint();
    };
    this.vis = function () {
      if (document.hidden) { cancelAnimationFrame(self.raf); self.raf = 0; self.last = 0; }
      else self.start();
    };
    if (!this.still) {
      startInput();
      document.addEventListener('visibilitychange', this.vis);
      // Off screen: no frame loop at all.
      if (typeof IntersectionObserver === 'function') {
        this.io = new IntersectionObserver(function (es) {
          self.inView = es[0].isIntersecting;
          if (self.inView) self.start();
          else { cancelAnimationFrame(self.raf); self.raf = 0; self.last = 0; }
        });
        this.io.observe(canvas);
      } else {
        this.start();
      }
    }
  }
  Smoke.prototype.start = function () {
    // a canvas the observer has put off screen stays off when the tab comes back
    if (!this.raf && !this.still && !document.hidden && this.inView !== false) this.raf = requestAnimationFrame(this.tick);
  };
  Smoke.prototype.size = function () {
    var r = this.c.getBoundingClientRect();
    this.c.width = Math.max(1, Math.round(r.width * this.scale));
    this.c.height = Math.max(1, Math.round(r.height * this.scale));
    this.paint();
  };
  Smoke.prototype.paint = function () {
    var a = this.atlas, ctx = this.ctx;
    if (!a || !ctx) return;
    var w = this.c.width, h = this.c.height;
    var cols = Math.ceil(w / a.cw), rows = Math.ceil(h / a.ch);
    ctx.clearRect(0, 0, w, h);
    if (this.ground) { ctx.fillStyle = this.ground; ctx.fillRect(0, 0, w, h); }
    // the pointer, in this canvas's own CSS px
    var lift = this.react && !this.still && input.active;
    var R = 170, px = 0, py = 0;
    if (lift) {
      var r = this.c.getBoundingClientRect();
      px = input.x - r.left; py = input.y - r.top;
      if (px < -R || py < -R || px > r.width + R || py > r.height + R) lift = false;
    }
    var cw = FLOW.cellW, ch = FLOW.cellH;
    for (var cy = 0; cy < rows; cy++) {
      for (var cx = 0; cx < cols; cx++) {
        var boost = 0;
        if (lift) {
          var dx = (cx + 0.5) * cw - px, dy = (cy + 0.5) * ch - py;
          var dd = dx * dx + dy * dy;
          if (dd < R * R) { var f = 1 - Math.sqrt(dd) / R; boost = 0.2 * f * f; }
        }
        var code = cellCode(cx, cy, this.clock, this.seed, this.threshold, boost);
        if (!code) continue;
        ctx.drawImage(a.sheet, (code & 255) * a.cw, ((code >> 8) - 1) * a.ch, a.cw, a.ch,
          cx * a.cw, cy * a.ch, a.cw, a.ch);
      }
    }
  };

  /* ── the startup intro's bolt, struck in glyphs (electron/splash/draw.js) ── */
  var BOLT_PATH = 'M36.9 13.6a3.2 3.2 0 0 0-5.4-1.6l-19 20.4A3.2 3.2 0 0 0 14.8 38h9.6l-3.3 12.4a3.2 3.2 0 0 0 5.4 1.6l19-20.4A3.2 3.2 0 0 0 43.2 26h-9.6z';
  var NOISE = '01<>/\\[]{}=+*#%:;!?';
  var BOLT_GLYPHS = ['.', ':', '-', '+', '=', '/', '\\', 'x', 'o', '*', 'z', 'Z', '%', '#', '$', '@', '&', '{', '}', '[', ']'];
  var TEAL = '#3EE6CF', INK = '#E8EAEA', INK2 = '#A2A7AB';

  function Bolt(canvas) {
    var d = canvas.dataset || {};
    var W = parseInt(d.w || '520', 10), H = parseInt(d.h || '340', 10);
    var CW = parseFloat(d.cw || '6'), CH = parseFloat(d.ch || '10');
    var K = parseFloat(d.k || '0'), FONT = parseFloat(d.font || '10');
    var hold = d.hold === '1';
    var fillA = parseFloat(d.fill || '0');
    this.c = canvas;
    var scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * scale; canvas.height = H * scale;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var off = document.createElement('canvas');
    off.width = W; off.height = H;
    var o = off.getContext('2d');
    if (K) { o.translate(W / 2 - K * 27.9, H / 2 - K * 32); o.scale(K, K); }
    else { o.translate(260 - 128, 116 - 128); o.scale(4, 4); }
    o.fillStyle = '#fff';
    try { o.fill(new Path2D(BOLT_PATH)); } catch (e) { return; }
    var img = o.getImageData(0, 0, W, H).data;
    var cols = Math.floor(W / CW), rows = Math.floor(H / CH);
    var cells = [];
    function on(cx, cy) {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false;
      var x = Math.floor(cx * CW + CW / 2), y = Math.floor(cy * CH + CH / 2);
      return img[(y * W + x) * 4 + 3] > 128;
    }
    for (var cy = 0; cy < rows; cy++) for (var cx = 0; cx < cols; cx++) {
      if (!on(cx, cy)) continue;
      var rim = !(on(cx - 1, cy) && on(cx + 1, cy) && on(cx, cy - 1) && on(cx, cy + 1));
      var hv = hash(cx, cy, 77);
      var glyph = rim ? BOLT_GLYPHS[Math.floor(hv * 5)] : BOLT_GLYPHS[Math.floor(hv * BOLT_GLYPHS.length)];
      cells.push({ x: cx, y: cy, rim: rim, glyph: glyph, h: hv });
    }
    var LOOP = 7.2, t0 = 0, raf = 0, running = false, lastDraw = 0;
    var still = reduced();
    var boltPath = new Path2D(BOLT_PATH);
    function frame(t) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = FONT + 'px "Geist Mono", Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var fade = (!hold && t > LOOP - 0.5) ? Math.max(0, (LOOP - t) / 0.5) : 1;
      if (fillA) {
        // a faint solid bolt under the glyphs, so the shape reads at a glance
        var fa = Math.min(1, Math.max(0, (t - 1.2) / 1.4)) * fillA * fade;
        if (fa > 0) {
          ctx.save();
          if (K) { ctx.translate(W / 2 - K * 27.9, H / 2 - K * 32); ctx.scale(K, K); }
          else { ctx.translate(132, -12); ctx.scale(4, 4); }
          ctx.globalAlpha = fa; ctx.fillStyle = TEAL; ctx.fill(boltPath);
          ctx.restore();
        }
      }
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        var lock = 0.9 + (c.y / rows) * 1.3 + c.h * 0.12;
        var ch, col, al = 1;
        if (t < lock - 0.22) continue;
        if (t < lock) {
          ch = NOISE[Math.floor(hash(c.x, c.y, Math.floor(t * 24)) * NOISE.length)];
          col = INK2; al = 0.7;
        } else {
          ch = c.glyph;
          var since = t - lock;
          col = since < 0.07 ? TEAL : INK;
          al = c.rim ? 0.82 : 0.95;
          // a slow teal light running down the finished bolt
          if (t > 2.6) {
            var band = ((c.y * 0.9 + c.x * 0.5) - (t - 2.6) * 22) % 46;
            if (band < 0) band += 46;
            if (band < 4) { col = TEAL; al = 1; }
          }
        }
        ctx.globalAlpha = al * fade;
        ctx.fillStyle = col;
        ctx.fillText(ch, c.x * CW + CW / 2, c.y * CH + CH / 2);
      }
      ctx.globalAlpha = 1;
    }
    function loop(now) {
      raf = requestAnimationFrame(loop);
      if (!t0) t0 = now;
      if (hold && now - lastDraw < 33) return;
      lastDraw = now;
      var el = (now - t0) / 1000;
      frame(hold ? el : el % LOOP);
    }
    function go() { if (!running && !still && !document.hidden) { running = true; if (!hold) t0 = 0; raf = requestAnimationFrame(loop); } }
    function halt() { running = false; cancelAnimationFrame(raf); }
    if (document.fonts && document.fonts.load) {
      document.fonts.load('10px "Geist Mono"').then(function () { if (still) frame(hold ? 2.5 : 3.0); }).catch(function () {});
    }
    if (still) { frame(hold ? 2.5 : 3.0); return; }
    document.addEventListener('visibilitychange', function () { if (document.hidden) halt(); else if (inView) go(); });
    var inView = true;
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function (es) { inView = es[0].isIntersecting; if (inView) go(); else halt(); }).observe(canvas);
    } else { go(); }
  }

  /* ── the backdrop: smoke + ASCII forward's bolt on one canvas fixed to the viewport ───────────
     The bolt is the same construction as ASCII forward's: the logo path flattened to a polygon,
     covered in cells (rim strokes - \ | / along the edge, a body of mono characters), letters flying
     in out of the smoke's wind and decoding top to bottom, the teal comet round the rim, sparks, then
     the shimmer lap and the decode front that keep it moving. Differences from flow.js, all for a
     whole-page layer: data-strength scales every glyph's alpha (the one contrast lever), the fly-in
     distances scale with the bolt's size, the bolt's size follows the viewport (three tiers, shrunk
     if the window is short), and the frame loop is its own (accumulated clock, paused while the tab
     is hidden). The smoke clears a hole round the bolt, as ASCII forward's does round its mark; the
     hole is worked out once per size, and the smoke's cell codes are refreshed at the smoke's own
     rate, so a frame allocates nothing. */
  var F_BODY = BOLT_GLYPHS;
  var F_TRAIL = '@%#*+=-:.';
  var F_MONO = '"Geist Mono", Consolas, monospace';
  // s: px per logo unit; cw/ch: cell px; font: px; alpha: the smoke's brightest/dimmest glyph; fps: smoke refresh
  var TIERS = {
    desktop: { s: 17.2, cw: 9, ch: 15, font: 12, maxA: 0.13, minA: 0.045, fps: 20 },
    tablet: { s: 13.5, cw: 7, ch: 12, font: 10.5, maxA: 0.11, minA: 0.04, fps: 15 },
    phone: { s: 10.8, cw: 6, ch: 10, font: 9, maxA: 0.11, minA: 0.04, fps: 12 }
  };
  function frand(i, salt) {
    var h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }
  function fclamp(v, lo, hi) { return Math.max(lo === undefined ? 0 : lo, Math.min(hi === undefined ? 1 : hi, v)); }
  function farc(x1, y1, x2, y2, r, large, sweep, steps) {
    var hx = (x1 - x2) / 2, hy = (y1 - y2) / 2, d2 = hx * hx + hy * hy;
    var radius = Math.max(r, Math.sqrt(d2));
    var k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (radius * radius - d2) / d2));
    var cx = k * hy + (x1 + x2) / 2, cy = -k * hx + (y1 + y2) / 2;
    var a1 = Math.atan2(y1 - cy, x1 - cx);
    var da = Math.atan2(y2 - cy, x2 - cx) - a1;
    if (sweep && da < 0) da += 2 * Math.PI;
    if (!sweep && da > 0) da -= 2 * Math.PI;
    var out = [];
    for (var s = 1; s <= steps; s += 1) {
      var a = a1 + (da * s) / steps;
      out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
    return out;
  }
  function fflatten(d, steps) {
    var tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+/g);
    var points = [], i = 0, cmd = '', x = 0, y = 0;
    function num() { return Number(tokens[i++]); }
    while (i < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
      var rel = cmd === cmd.toLowerCase();
      var ox = rel ? x : 0, oy = rel ? y : 0;
      switch (cmd.toLowerCase()) {
        case 'm':
        case 'l':
          x = ox + num(); y = oy + num(); points.push([x, y]);
          if (cmd === 'm') cmd = 'l';
          if (cmd === 'M') cmd = 'L';
          break;
        case 'h': x = ox + num(); points.push([x, y]); break;
        case 'v': y = oy + num(); points.push([x, y]); break;
        case 'a': {
          var r = num(); num(); num();
          var large = num(), sweep = num();
          var nx = ox + num(), ny = oy + num();
          var pts = farc(x, y, nx, ny, r, large, sweep, steps);
          for (var q = 0; q < pts.length; q += 1) points.push(pts[q]);
          x = nx; y = ny;
          break;
        }
        default: break;
      }
    }
    return points;
  }
  function finside(poly, x, y) {
    var hit = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  function fsegDist(ax, ay, bx, by, x, y) {
    var dx = bx - ax, dy = by - ay;
    var k = fclamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
    return Math.hypot(ax + dx * k - x, ay + dy * k - y);
  }
  function fstroke(dx, dy) {
    var deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < 0) deg += 180;
    if (deg < 22 || deg >= 158) return '-';
    if (deg < 68) return '\\';
    if (deg < 112) return '|';
    return '/';
  }
  var RAW_POLY = fflatten(BOLT_PATH, 6);
  var RAW = (function () {
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (var i = 0; i < RAW_POLY.length; i += 1) {
      minX = Math.min(minX, RAW_POLY[i][0]); maxX = Math.max(maxX, RAW_POLY[i][0]);
      minY = Math.min(minY, RAW_POLY[i][1]); maxY = Math.max(maxY, RAW_POLY[i][1]);
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, mx: (minX + maxX) / 2, my: (minY + maxY) / 2 };
  })();

  function Backdrop(canvas) {
    var d = canvas.dataset || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strength = parseFloat(d.strength || '1');
    this.seed = parseInt(d.seed || '2', 10);
    this.threshold = parseFloat(d.threshold || '0.62');
    this.smokeOn = d.smoke !== 'off';
    this.o = TIERS.desktop;
    this.tierName = '';
    this.cells = []; this.sparks = [];
    this.clock = 0; this.sclock = 40;
    this.raf = 0; this.last = 0; this.lastDraw = 0; this.lastSmoke = 0;
    this.atlas = null; this.atlasKey = '';
    this.codes = null; this.hole = null; this.cols = 0; this.rows = 0;
    this.still = reduced();
    var self = this;
    if (!this.ctx) { document.documentElement.classList.add('no-canvas'); return; }
    this.tick = function (now) {
      self.raf = requestAnimationFrame(self.tick);
      if (now - self.lastDraw < 1000 / 30 - 1) return;
      var dt = self.last ? Math.min(0.25, (now - self.last) / 1000) : 0;
      self.clock += dt; self.last = now; self.lastDraw = now;
      if (self.smokeOn && now - self.lastSmoke >= 1000 / self.o.fps - 1) {
        var sdt = self.lastSmoke ? Math.min(0.25, (now - self.lastSmoke) / 1000) : 0;
        self.sclock += sdt * (1 + input.boost * 2.2);
        input.boost *= 0.93;
        self.lastSmoke = now;
        self.smoke(self.sclock);
      }
      self.draw(self.clock, false);
    };
    var begin = function () {
      if (self.ready) return;
      self.ready = true;
      self.size();
      if (typeof ResizeObserver === 'function') {
        self.ro = new ResizeObserver(function () { self.size(); });
        self.ro.observe(canvas);
      }
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) self.halt(); else self.go();
      });
      if (reduceQuery && reduceQuery.addEventListener) {
        reduceQuery.addEventListener('change', function () {
          self.still = reduced();
          if (self.still) { self.halt(); self.sclock = 40; self.size(); }
          else { startInput(); self.go(); }
        });
      }
      if (!self.still) startInput();
      self.go();
    };
    if (document.fonts && document.fonts.load) document.fonts.load('10px "Geist Mono"').then(begin, begin);
    else begin();
  }
  Backdrop.prototype.go = function () { if (!this.raf && !this.still && !document.hidden) this.raf = requestAnimationFrame(this.tick); };
  Backdrop.prototype.halt = function () { cancelAnimationFrame(this.raf); this.raf = 0; this.last = 0; this.lastSmoke = 0; };
  Backdrop.prototype.size = function () {
    var W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    var sc = Math.min(2, window.devicePixelRatio || 1);
    this.W = W; this.H = H; this.sc = sc;
    this.canvas.width = Math.max(1, Math.round(W * sc));
    this.canvas.height = Math.max(1, Math.round(H * sc));
    // the tier follows the viewport; a short window shrinks the whole bolt to fit
    var tier = W <= 480 ? 'phone' : (W < 1024 || H < 760 ? 'tablet' : 'desktop');
    var t = TIERS[tier], fit = Math.min(1, (H * 0.92) / ((RAW.maxY - RAW.minY) * t.s));
    this.tierName = tier;
    this.o = { s: t.s * fit, cw: t.cw * fit, ch: t.ch * fit, font: Math.max(7, t.font * fit), maxA: t.maxA, minA: t.minA, fps: t.fps };
    this.fontStr = this.o.font + 'px ' + F_MONO;
    this.build();
    if (this.smokeOn) this.smokeGrid(); else this.codes = null;
    this.smoke(this.still ? 40 : this.sclock);
    this.draw(this.still ? 0 : this.clock, this.still);
  };
  Backdrop.prototype.smokeGrid = function () {
    var key = this.sc + '|' + this.o.maxA + '|' + this.o.minA;
    if (!this.atlas || this.atlasKey !== key) {
      this.atlas = buildAtlas(INK, this.sc, this.o.minA, this.o.maxA);
      this.atlasKey = key;
    }
    var a = this.atlas;
    if (!a) { this.codes = null; return; }
    var cols = Math.ceil(this.canvas.width / a.cw), rows = Math.ceil(this.canvas.height / a.ch);
    this.cols = cols; this.rows = rows;
    this.codes = new Uint16Array(cols * rows);
    // the clear space round the bolt: cells inside its outline, or within `margin` of it, stay empty
    this.hole = new Uint8Array(cols * rows);
    var m = this.margin, sc = this.sc;
    for (var cy = 0; cy < rows; cy += 1) {
      var y = (cy + 0.5) * a.ch / sc;
      if (y < this.by0 - m || y > this.by1 + m) continue;
      for (var cx = 0; cx < cols; cx += 1) {
        var x = (cx + 0.5) * a.cw / sc;
        if (x < this.bx0 - m || x > this.bx1 + m) continue;
        var inHole = finside(this.poly, x, y);
        for (var i = 0; !inHole && i < this.poly.length; i += 1) {
          var pa = this.poly[i], pb = this.poly[(i + 1) % this.poly.length];
          if (fsegDist(pa[0], pa[1], pb[0], pb[1], x, y) < m) inHole = true;
        }
        if (inHole) this.hole[cy * cols + cx] = 1;
      }
    }
  };
  /* refresh the smoke's cell codes for clock t (the pointer lifts the smoke under it) */
  Backdrop.prototype.smoke = function (t) {
    var codes = this.codes, a = this.atlas;
    if (!codes || !a) return;
    var cols = this.cols, rows = this.rows, hole = this.hole;
    var lift = !this.still && input.active, R = 170, R2 = R * R, px = input.x, py = input.y;
    var cw = FLOW.cellW, ch = FLOW.cellH;
    for (var cy = 0; cy < rows; cy += 1) {
      for (var cx = 0; cx < cols; cx += 1) {
        var i = cy * cols + cx;
        if (hole[i]) { codes[i] = 0; continue; }
        var boost = 0;
        if (lift) {
          var dx = (cx + 0.5) * cw - px, dy = (cy + 0.5) * ch - py, dd = dx * dx + dy * dy;
          if (dd < R2) { var f = 1 - Math.sqrt(dd) / R; boost = 0.2 * f * f; }
        }
        codes[i] = cellCode(cx, cy, t, this.seed, this.threshold, boost);
      }
    }
  };
  Backdrop.prototype.build = function () {
    var o = this.o, W = this.W, H = this.H, K = o.s / 10;
    var raw = RAW_POLY, i;
    var minX = RAW.minX, maxX = RAW.maxX, minY = RAW.minY, maxY = RAW.maxY, mx = RAW.mx, my = RAW.my;
    var poly = raw.map(function (p) { return [W / 2 + (p[0] - mx) * o.s, H / 2 + (p[1] - my) * o.s]; });
    var bx0 = W / 2 + (minX - mx) * o.s, bx1 = W / 2 + (maxX - mx) * o.s;
    var by0 = H / 2 + (minY - my) * o.s, by1 = H / 2 + (maxY - my) * o.s;
    var cols = Math.ceil((bx1 - bx0) / o.cw) + 2, rows = Math.ceil((by1 - by0) / o.ch) + 2;
    var left = W / 2 - (cols * o.cw) / 2, top = H / 2 - (rows * o.ch) / 2;
    var cum = [0];
    for (i = 1; i <= poly.length; i += 1) {
      var a = poly[i - 1], b = poly[i % poly.length];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    var per = cum[cum.length - 1];
    var samples = [];
    for (var s = 0; s < 160; s += 1) {
      var target = (s / 160) * per, k = 1;
      while (cum[k] < target) k += 1;
      var p0 = poly[k - 1], p1 = poly[k % poly.length];
      var f = (target - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
      samples.push([p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f]);
    }
    var cov = new Float32Array(cols * rows), r, c;
    for (r = 0; r < rows; r += 1) {
      for (c = 0; c < cols; c += 1) {
        var hits = 0;
        for (var sy = 0; sy < 4; sy += 1) for (var sx = 0; sx < 4; sx += 1) {
          if (finside(poly, left + (c + (sx + 0.5) / 4) * o.cw, top + (r + (sy + 0.5) / 4) * o.ch)) hits += 1;
        }
        cov[r * cols + c] = hits / 16;
      }
    }
    function lit(rr, cc) { return rr >= 0 && cc >= 0 && rr < rows && cc < cols && cov[rr * cols + cc] >= 0.19; }
    var cells = [];
    for (r = 0; r < rows; r += 1) {
      for (c = 0; c < cols; c += 1) {
        if (!lit(r, c)) continue;
        var cv = cov[r * cols + c], key = r * cols + c;
        var rim = !lit(r - 1, c) || !lit(r + 1, c) || !lit(r, c - 1) || !lit(r, c + 1);
        var x = left + (c + 0.5) * o.cw, y = top + (r + 0.5) * o.ch;
        var row = fclamp((y - by0) / (by1 - by0)), across = fclamp((x - bx0) / (bx1 - bx0));
        if (!rim && frand(key, 5) > 0.975) continue;
        var light = 1 - 0.45 * fclamp((across + row) / 2);
        var shade = fclamp(Math.round(cv * light * 5), 0, 5);
        var reach = 0.6 + 0.4 * (shade / 5);
        var base = Math.min(F_BODY.length - 1, Math.floor(frand(key, 1) * F_BODY.length * reach));
        var chr = F_BODY[base], at = 0;
        if (rim) {
          var best = 1e9, dir = [1, 0], best2 = 1e9;
          for (i = 0; i < poly.length; i += 1) {
            var pa = poly[i], pb = poly[(i + 1) % poly.length];
            var dd = fsegDist(pa[0], pa[1], pb[0], pb[1], x, y);
            if (dd < best) { best = dd; dir = [pb[0] - pa[0], pb[1] - pa[1]]; }
          }
          chr = fstroke(dir[0], dir[1]);
          for (var q = 0; q < samples.length; q += 1) {
            var dq = Math.hypot(samples[q][0] - x, samples[q][1] - y);
            if (dq < best2) { best2 = dq; at = q / samples.length; }
          }
        }
        cells.push({
          key: key, x: rim ? x : x + (frand(key, 6) - 0.5) * o.cw * 0.18, y: rim ? y : y + (frand(key, 7) - 0.5) * o.ch * 0.12,
          row: row, rim: rim, ch: chr, alpha: rim ? 1 : 0.58 + 0.37 * (shade / 5), at: at,
          settle: row * 0.85 + frand(key, 2) * 0.15, far: (150 + 300 * frand(key, 21)) * K, perp: (frand(key, 22) - 0.5) * 90 * K
        });
      }
    }
    this.cells = cells;
    this.poly = poly; this.bx0 = bx0; this.bx1 = bx1; this.by0 = by0; this.by1 = by1; this.margin = o.s * 1.6;
    var rimCells = cells.filter(function (cell) { return cell.rim; });
    this.sparks = [];
    for (var n = 0; n < 14 && rimCells.length; n += 1) {
      var from = rimCells[Math.floor(frand(n, 11) * rimCells.length)];
      var ang = Math.atan2(from.y - H / 2, from.x - W / 2) + (frand(n, 12) - 0.5) * 0.9;
      var spd = (70 + frand(n, 13) * 90) * (o.s / 4) * 0.7;
      this.sparks.push({ x: from.x, y: from.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 30, life: 0.55 + frand(n, 14) * 0.4, ch: '+*.x'.charAt(n % 4) });
    }
  };
  /* t: seconds since the bolt began to gather. still: the finished mark, no motion. */
  Backdrop.prototype.draw = function (t, still) {
    var ctx = this.ctx, K = this.strength;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // the smoke, cell by cell, from the atlas (device pixels)
    var a = this.atlas, codes = this.codes;
    if (codes && a) {
      var cols = this.cols, rows = this.rows, aw = a.cw, ah = a.ch;
      for (var cy = 0; cy < rows; cy += 1) {
        for (var cx = 0; cx < cols; cx += 1) {
          var code = codes[cy * cols + cx];
          if (!code) continue;
          ctx.drawImage(a.sheet, (code & 255) * aw, ((code >> 8) - 1) * ah, aw, ah, cx * aw, cy * ah, aw, ah);
        }
      }
    }
    // the bolt (CSS pixels)
    ctx.setTransform(this.sc, 0, 0, this.sc, 0, 0);
    ctx.font = this.fontStr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var cells = this.cells, FD = 0.9, T0 = 1.1, CD = 1.4, TRAIL_LEN = 0.075, LAP = 2.6, SETTLE = 3.0;
    var idle = !still && t > SETTLE;
    var g = idle ? ((t - SETTLE) / LAP) % 1 : -1;
    var scanPh = !still && t > 7 ? (t - 7) % 13 : 99;
    var front = scanPh < 1.2 ? scanPh / 1.2 : -1;
    var lastInk = '', lastA = -1;
    for (var i = 0; i < cells.length; i += 1) {
      var c = cells[i], ink = INK, al = c.alpha, ch = c.ch, x = c.x, y = c.y;
      if (still) {
        // the finished mark
      } else {
        var arrive = 0.15 + c.settle * 1.1, start = arrive - FD;
        if (t < start) continue;
        var p = Math.min(1, (t - start) / FD);
        var e = p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
        if (p < 1) {
          var dist = c.far * (1 - e);
          x += -COS * dist - SIN * c.perp * (1 - e);
          y += -SIN * dist + COS * c.perp * (1 - e);
          ch = NOISE.charAt(Math.floor(hash(c.key, Math.floor(t * 24), 31) * NOISE.length));
          al = (0.12 + 0.55 * e) * c.alpha;
        } else if (t - arrive < 0.16) {
          ink = TEAL; al = 1;
        }
        if (c.rim) {
          var f = (t - T0) / CD;
          if (f >= 0 && f < 1.1) {
            var dd = f - c.at;
            if (dd >= 0 && dd < TRAIL_LEN) {
              var idx = Math.floor((dd / TRAIL_LEN) * F_TRAIL.length);
              ch = F_TRAIL.charAt(idx); ink = idx === 0 ? TEAL : INK; al = Math.max(al, 1 - idx / F_TRAIL.length);
            }
          }
          if (g >= 0) {
            var dg = (((g - c.at) % 1) + 1) % 1;
            if (dg < 0.09) { ink = TEAL; al = 1; }
          }
        }
        if (front >= 0 && c.row <= front && c.row > front - 0.1) {
          ink = TEAL; al = 0.95;
          ch = NOISE.charAt(Math.floor(hash(c.key, Math.floor(t * 24), 33) * NOISE.length));
        }
      }
      if (ink !== lastInk) { ctx.fillStyle = ink; lastInk = ink; }
      if (al !== lastA) { ctx.globalAlpha = al * K; lastA = al; }
      ctx.fillText(ch, x, y);
    }
    if (!still && t > 1.75 && t < 2.6) {
      ctx.fillStyle = TEAL;
      var tau = t - 1.75;
      for (var s = 0; s < this.sparks.length; s += 1) {
        var sp = this.sparks[s], kk = tau / (0.6 * sp.life + 0.15);
        if (kk >= 1) continue;
        ctx.globalAlpha = (1 - kk) * 0.9 * K;
        ctx.fillText(sp.ch, sp.x + sp.vx * tau, sp.y + sp.vy * tau + 60 * tau * tau);
      }
    }
    ctx.globalAlpha = 1;
  };

  function scan() {
    var list = document.querySelectorAll('canvas[data-flow]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.__shipitFlow) continue;
      el.__shipitFlow = true;
      try {
        var kind = el.getAttribute('data-flow');
        if (kind === 'backdrop') new Backdrop(el); else if (kind === 'bolt') new Bolt(el); else new Smoke(el);
      } catch (e) { /* decoration only */ }
    }
    var vids = document.querySelectorAll('video[data-motion]');
    if (reduced()) {
      for (var j = 0; j < vids.length; j++) { try { vids[j].pause(); vids[j].removeAttribute('autoplay'); } catch (e) {} }
    }
  }

  window.shipitFlow = { scan: scan };
  if (document.readyState !== 'loading') scan();
  else document.addEventListener('DOMContentLoaded', scan);
})();
