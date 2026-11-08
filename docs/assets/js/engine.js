/*
 * ascii-engine — shared core for full-screen glyph scenes (the "world" look).
 *
 * Grid   : the character grid a scene draws into. Per-cell glyph, colour,
 *          alpha and depth; text dimming; point lights with bloom; drawing
 *          batched into runs of same-coloured text.
 * Ground : a background layer kept in its own canvas and refreshed a few
 *          rows per frame, so a screen full of grass doesn't cost a full
 *          redraw every frame. Scenes fill it through `groundAt`.
 *
 * Exposes window.AsciiEngine = { Grid, helpers... }.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;

  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function angleDiff(a, b) {
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  function hash(x, y, z) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function noise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
    const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  const mix = (a, b, t) => [
    (a[0] + (b[0] - a[0]) * t) | 0,
    (a[1] + (b[1] - a[1]) * t) | 0,
    (a[2] + (b[2] - a[2]) * t) | 0,
  ];
  const pack = (c) => (c[0] << 16) | (c[1] << 8) | c[2];

  function gradient(stops, t) {
    const x = clamp(t, 0, 1) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    return mix(stops[i], stops[i + 1], x - i);
  }

  function hexToRgb(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 176, 32];
  }

  // The ASCII stroke closest to a screen-space direction. Cells are about
  // twice as tall as wide, so '/' and '\' read steeper than 45°.
  function strokeGlyph(dx, dy) {
    const a = Math.atan2(Math.abs(dy), Math.abs(dx));
    if (a < 0.42) return 45; // '-'
    if (a > 1.22) return 124; // '|'
    return dx * dy > 0 ? 92 : 47; // '\' : '/'
  }

  function popcount6(m) {
    m = m - ((m >> 1) & 0x15);
    m = (m & 0x33) + ((m >> 2) & 0x33);
    return (m + (m >> 4)) & 0x0f;
  }

  // Density ramp, sparse → dense. On night ground, dense reads bright.
  const RAMP = ' .:-=+*#%@';
  const RAMP_CODES = Array.from(RAMP, (c) => c.charCodeAt(0));

  /* ------------------------------------------------------------------ */
  /* Shape matching: edge cells pick the glyph whose ink sits where the   */
  /* shape is, measured from the real font at a 2×3 grid of sample points. */
  /* ------------------------------------------------------------------ */

  const SUB_X = [0.28, 0.72, 0.28, 0.72, 0.28, 0.72];
  const SUB_Y = [0.2, 0.2, 0.5, 0.5, 0.8, 0.8];
  const EDGE_CANDIDATES = ".,:;'`\"^_-~=+*<>/\\|()[]{}!7LJTYVvrjil";

  function buildShapeTable(font) {
    const scale = 6;
    const W = Math.round(font.cw * scale), H = Math.round(font.ch * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = `${font.weight} ${font.px * scale}px ${font.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';

    const shapes = [];
    let peak = 0;
    for (const ch of EDGE_CANDIDATES) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillText(ch, W / 2, H / 2 + scale);
      const data = ctx.getImageData(0, 0, W, H).data;
      const v = new Float32Array(6);
      for (let y = 0; y < H; y++) {
        const row = Math.min(2, Math.floor((y / H) * 3));
        for (let x = 0; x < W; x++) v[row * 2 + (x < W / 2 ? 0 : 1)] += data[(y * W + x) * 4 + 3] / 255;
      }
      const area = (W / 2) * (H / 3);
      for (let i = 0; i < 6; i++) peak = Math.max(peak, (v[i] /= area));
      shapes.push({ code: ch.charCodeAt(0), v });
    }
    for (const s of shapes) for (let i = 0; i < 6; i++) s.v[i] /= peak;

    const table = new Uint16Array(64);
    for (let mask = 1; mask < 64; mask++) {
      let best = 46, bestScore = Infinity;
      for (const s of shapes) {
        let score = 0;
        for (let i = 0; i < 6; i++) {
          const want = mask & (1 << i) ? 0.55 : 0;
          const diff = s.v[i] - want;
          // Ink where the shape isn't is worse than missing ink where it is.
          score += diff > 0 && !want ? diff * diff * 2.2 : diff * diff;
        }
        if (score < bestScore) {
          bestScore = score;
          best = s.code;
        }
      }
      table[mask] = best;
    }
    table[0] = 32;
    return table;
  }

  /* ------------------------------------------------------------------ */
  /* Mixed glyph pools: every RAMP level gets a handful of glyphs with    */
  /* about the same ink, measured from the real font, so a solid fill     */
  /* reads as texture rather than one character repeated.                 */
  /* ------------------------------------------------------------------ */

  // No '$' or '?': they read as symbols, not as texture.
  const POOL_CANDIDATES = "!\"#%&'()*+,-./:;<=>@[\\]^_`{|}~08O";
  const POOL_SIZE = 5;

  // Also returns each printable glyph's ink (0..1, densest = 1), which the glow pass weighs by.
  function buildDensityPools(font) {
    const scale = 4;
    const W = Math.round(font.cw * scale), H = Math.round(font.ch * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = `${font.weight} ${font.px * scale}px ${font.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const measure = (ch) => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillText(ch, W / 2, H / 2 + scale);
      const data = ctx.getImageData(0, 0, W, H).data;
      let ink = 0, cy = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const a = data[(y * W + x) * 4 + 3] / 255;
          ink += a;
          cy += a * y;
        }
      }
      // Ink far off the middle (_ ^ `) sits on one edge of the cell and stripes a fill.
      return { code: ch.charCodeAt(0), ink: ink / (W * H), off: ink ? Math.abs(cy / ink / H - 0.5) : 1 };
    };
    const anchors = Array.from(RAMP, measure);
    const glyphs = Array.from(POOL_CANDIDATES, measure).filter((s) => s.off < 0.2);
    const pools = anchors.map((a, k) => {
      if (k === 0) return [32];
      // Most of the way to each neighbouring level is as far as a glyph may stray.
      const lo = a.ink - (a.ink - anchors[k - 1].ink) * 0.8;
      const hi = k < anchors.length - 1 ? a.ink + (anchors[k + 1].ink - a.ink) * 0.8 : Infinity;
      const near = glyphs
        .filter((s) => s.code !== a.code && s.ink > lo && s.ink < hi)
        .sort((s, t) => Math.abs(s.ink - a.ink) - Math.abs(t.ink - a.ink))
        .slice(0, POOL_SIZE - 1);
      return [a.code, ...near.map((s) => s.code)];
    });
    const ink = new Float32Array(128);
    let peak = 0;
    for (let c = 33; c < 127; c++) peak = Math.max(peak, (ink[c] = measure(String.fromCharCode(c)).ink));
    for (let c = 33; c < 127; c++) ink[c] /= peak;
    return { pools, ink };
  }

  // Group nearby boxes so creatures don't thread between lines of text.
  function mergeBoxes(boxes) {
    const merged = [];
    for (const b of [...boxes].sort((a, c) => a.top - c.top)) {
      const m = merged.find((o) => b.top - o.bottom < 160 && b.left - o.right < 160 && o.left - b.right < 160);
      if (!m) {
        merged.push({ ...b });
        continue;
      }
      m.left = Math.min(m.left, b.left);
      m.right = Math.max(m.right, b.right);
      m.bottom = Math.max(m.bottom, b.bottom);
    }
    return merged;
  }

  /* ------------------------------------------------------------------ */
  /* Grid                                                                */
  /* ------------------------------------------------------------------ */

  class Grid {
    constructor(canvas, family) {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      this.ctx = ctx;
      this.family = family;
      this.groundCanvas = document.createElement('canvas');
      this.gctx = this.groundCanvas.getContext('2d');
      this.cols = 0;
      this.rows = 0;
      this.font = null;
      this.table = null;
      this.styles = new Map();
      this.lights = [];
      this.chars = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));
      this.bg = [8, 11, 20];
      this.groundRow = 0;
      this.flash = 0; // 0..1, a lightning flash over the whole frame
      this.reveal = 1; // 0..1, a decode wave down the screen; 1 is fully shown
      this.mask = null; // { x, y, r, soft }: only a circle of the scene shows (the lantern intro)
      // ?mixed=0 and ?glow=0 turn the two looks off, for comparing.
      const q = new URLSearchParams(location.search);
      this.mixed = q.get('mixed') === '0' ? 0 : 0.6; // share of fill cells that leave the plain ramp glyph
      this.glow = q.get('glow') === '0' ? 0 : 0.75; // strength of the glyph glow pass
      this.glowCanvas = [document.createElement('canvas'), document.createElement('canvas')];
      this.glowData = null;
    }

    // A fill glyph for RAMP level k (0..9) at cell i. Mostly the ramp glyph,
    // sometimes another of the same ink, fixed per cell so it never flickers.
    ramp(k, i) {
      const pool = this.pools[k];
      const h = hash(i, k, 77);
      if (pool.length < 2 || h >= this.mixed) return pool[0];
      return pool[1 + Math.floor((h / this.mixed) * (pool.length - 1))];
    }

    resize(w, h, dpr, px) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      const ctx = this.ctx;
      ctx.font = `600 ${px}px ${this.family}`;
      // Cells are exactly one glyph advance wide, so a run of text lines up with the grid.
      const cw = ctx.measureText('M').width;
      const ch = Math.round(px * 1.22);
      if (!this.font || this.font.px !== px) {
        this.font = { px, cw, ch, weight: 600, family: this.family };
        this.table = buildShapeTable(this.font);
        ({ pools: this.pools, ink: this.ink } = buildDensityPools(this.font));
      }
      this.cw = cw;
      this.ch = ch;
      this.cols = Math.ceil(w / cw);
      this.rows = Math.ceil(h / ch);
      for (const c of [ctx.canvas, this.groundCanvas]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const n = this.cols * this.rows;
      this.glyph = new Uint16Array(n);
      this.color = new Uint32Array(n);
      this.alpha = new Float32Array(n);
      this.layer = new Float32Array(n);
      this.dim = new Float32Array(n).fill(1);
      this.dimKey = null; // the fresh dim map is blank, so the next boxes must apply
      this.light = new Float32Array(n * 3);
      this.gGlyph = new Uint16Array(n);
      this.gColor = new Uint32Array(n);
      this.gAlpha = new Float32Array(n);
      this.groundStale = true;
    }

    // Fade the scene near the text so it stays readable.
    setDimBoxes(boxes) {
      const key = JSON.stringify(boxes.map((b) => [b.left | 0, b.top | 0, b.right | 0, b.bottom | 0]));
      if (key === this.dimKey) return;
      this.dimKey = key;
      const { cols, rows, cw, ch, dim } = this;
      dim.fill(1);
      const pad = 6 * cw;
      for (const b of boxes) {
        const c0 = Math.max(0, Math.floor((b.left - pad) / cw)), c1 = Math.min(cols - 1, Math.floor((b.right + pad) / cw));
        const r0 = Math.max(0, Math.floor((b.top - pad) / ch)), r1 = Math.min(rows - 1, Math.floor((b.bottom + pad) / ch));
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const x = c * cw + cw / 2, y = r * ch + ch / 2;
            const d = Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom));
            const i = r * cols + c;
            dim[i] = Math.min(dim[i], 0.1 + 0.9 * smoothstep(0, pad, d));
          }
        }
      }
      this.groundStale = true;
    }

    clear() {
      this.glyph.fill(0);
      this.layer.fill(0);
      this.light.fill(0);
      this.lights.length = 0;
    }

    put(i, code, rgb, alpha, z) {
      if (z < this.layer[i]) return;
      this.layer[i] = z;
      this.glyph[i] = code;
      this.color[i] = rgb;
      this.alpha[i] = alpha;
    }

    cellAt(x, y) {
      const c = Math.floor(x / this.cw), r = Math.floor(y / this.ch);
      return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
    }

    // A straight line of stroke glyphs, one per cell it crosses.
    stroke(x0, y0, x1, y1, rgb, alpha, z) {
      const code = strokeGlyph(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0) / this.cw, Math.abs(y1 - y0) / this.ch) * 1.5));
      let last = -1;
      for (let s = 0; s <= steps; s++) {
        const i = this.cellAt(lerp(x0, x1, s / steps), lerp(y0, y1, s / steps));
        if (i < 0 || i === last) continue;
        last = i;
        this.put(i, code, rgb, alpha, z);
      }
    }

    // A point light: brightens and warms glyphs within r px, plus bloom.
    addLight(x, y, r, k, rgb) {
      if (k <= 0.005) return;
      this.lights.push({ x, y, r, k, rgb });
      const { cols, rows, cw, ch, light } = this;
      const c0 = Math.max(0, Math.floor((x - r) / cw)), c1 = Math.min(cols - 1, Math.floor((x + r) / cw));
      const r0 = Math.max(0, Math.floor((y - r) / ch)), r1 = Math.min(rows - 1, Math.floor((y + r) / ch));
      const lr = rgb[0] / 255, lg = rgb[1] / 255, lb = rgb[2] / 255;
      for (let rr = r0; rr <= r1; rr++) {
        const dy = rr * ch + ch / 2 - y;
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(c * cw + cw / 2 - x, dy) / r;
          if (d >= 1) continue;
          const f = k * (1 - d) * (1 - d);
          const j = (rr * cols + c) * 3;
          light[j] += f * lr;
          light[j + 1] += f * lg;
          light[j + 2] += f * lb;
        }
      }
    }

    style(rgb) {
      let s = this.styles.get(rgb);
      if (!s) {
        s = `rgb(${rgb >>> 16},${(rgb >>> 8) & 255},${rgb & 255})`;
        this.styles.set(rgb, s);
      }
      return s;
    }

    /* --- ground layer -------------------------------------------- */

    // Refresh a slice of ground rows (all of them when stale) through
    // groundAt(i, c, r), which writes gGlyph/gColor/gAlpha for one cell.
    refreshGround(groundAt, fraction) {
      const { rows, cols } = this;
      const count = this.groundStale ? rows : Math.max(1, Math.ceil(rows * fraction));
      const g = this.gctx;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.textSetup(g);
      for (let n = 0; n < count; n++) {
        const r = this.groundStale ? n : (this.groundRow + n) % rows;
        for (let c = 0; c < cols; c++) groundAt(r * cols + c, c, r);
        g.clearRect(0, r * this.ch, this.w, this.ch);
        this.drawRow(g, r, this.gGlyph, this.gColor, this.gAlpha, false);
      }
      if (!this.groundStale) this.groundRow = (this.groundRow + count) % rows;
      this.groundStale = false;
    }

    textSetup(ctx) {
      const f = this.font;
      ctx.font = `${f.weight} ${f.px}px ${f.family}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
    }

    // One row of cells as runs of same-coloured text; `lit` applies the
    // light buffer. Colour is quantised to 4 bits a channel and alpha to 10
    // steps so neighbouring cells join the same run.
    drawRow(ctx, r, glyph, color, alpha, lit, skip) {
      const { cols, cw, ch, dim, light, chars } = this;
      const y = r * ch + ch / 2 + 1;
      let runKey = -1, runText = '', runCol = 0;
      const flush = () => {
        if (!runText) return;
        ctx.fillText(runText, runCol * cw, y);
        runText = '';
      };
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const code = glyph[i];
        if (!code || code === 32 || (skip && skip[i])) {
          flush();
          runKey = -1;
          continue;
        }
        let a = alpha[i] * dim[i];
        let rgb = color[i];
        if (lit) {
          // Lit glyphs brighten, take on the light's colour and come forward.
          const j = i * 3, lr = light[j], lg = light[j + 1], lb = light[j + 2];
          const l = (lr + lg + lb) / 3;
          if (l > 0.004) {
            const rr = Math.min(255, (rgb >>> 16) * (1 + 1.4 * lr) + 90 * lr);
            const gg = Math.min(255, ((rgb >>> 8) & 255) * (1 + 1.4 * lg) + 90 * lg);
            const bb = Math.min(255, (rgb & 255) * (1 + 1.4 * lb) + 90 * lb);
            rgb = (rr << 16) | (gg << 8) | bb;
            a = Math.min(1, a + 0.9 * l * dim[i]);
          }
        }
        if (a < 0.01) {
          flush();
          runKey = -1;
          continue;
        }
        const aq = Math.min(10, Math.round(a * 10));
        rgb = (rgb & 0xf0f0f0) | 0x080808;
        const key = rgb * 11 + aq;
        if (key !== runKey) {
          flush();
          runKey = key;
          runCol = c;
          ctx.fillStyle = this.style(rgb);
          ctx.globalAlpha = aq / 10;
        }
        runText += chars[code];
      }
      flush();
      ctx.globalAlpha = 1;
    }

    // The decode band: whatever will be there, as random characters in its colour.
    drawScramble(ctx, r0, r1) {
      const { cols, cw, ch, glyph, gGlyph, color, gColor, chars } = this;
      const pool = '#%&@$*+=?!/\\|<>~^:;';
      ctx.globalAlpha = 0.85;
      for (let r = r0; r < r1; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const real = glyph[i] > 32 ? glyph[i] : gGlyph[i];
          if (!real || real === 32) continue;
          ctx.fillStyle = this.style((glyph[i] > 32 ? color[i] : gColor[i]) & 0xf0f0f0);
          ctx.fillText(chars[pool.charCodeAt(Math.floor(Math.random() * pool.length))] || '#', c * cw, r * ch + ch / 2 + 1);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Glyph glow: one pixel per cell holding how much light that glyph gives
    // off (its colour past a brightness threshold, times its ink), blurred
    // back up over the frame. Bright glyphs bleed; dim ones stay crisp.
    drawGlow() {
      const { ctx, cols, rows, glyph, gGlyph, light, dim, ink, cw, ch } = this;
      const [src, wide] = this.glowCanvas;
      if (src.width !== cols || src.height !== rows) {
        src.width = cols;
        src.height = rows;
        this.glowData = src.getContext('2d').createImageData(cols, rows);
      }
      const d = this.glowData.data;
      const n = cols * rows;
      if (!this.glowE || this.glowE.length !== n) {
        this.glowE = new Float32Array(n);
        this.glowRgb = new Uint32Array(n);
        this.glowH = new Float32Array(n);
        this.glowM = new Float32Array(n);
      }
      const E = this.glowE, RGB = this.glowRgb, Hs = this.glowH, M = this.glowM;
      // Over a pale daytime ground only really bright ink glows.
      const bgLum = (0.3 * this.bg[0] + 0.59 * this.bg[1] + 0.11 * this.bg[2]) / 255;
      const th = Math.max(0.42, bgLum + 0.3);
      const m = this.mask;
      for (let i = 0; i < n; i++) {
        let code = glyph[i], rgb, a;
        if (code > 32) {
          rgb = this.color[i];
          a = this.alpha[i];
        } else {
          code = gGlyph[i];
          rgb = this.gColor[i];
          a = this.gAlpha[i];
        }
        let k = 0, R = 0, G = 0, B = 0;
        if (code > 32 && code < 128) {
          const j = i * 3;
          R = Math.min(255, (rgb >>> 16) * (1 + 1.4 * light[j]) + 90 * light[j]);
          G = Math.min(255, ((rgb >>> 8) & 255) * (1 + 1.4 * light[j + 1]) + 90 * light[j + 1]);
          B = Math.min(255, (rgb & 255) * (1 + 1.4 * light[j + 2]) + 90 * light[j + 2]);
          k = smoothstep(th, 1, (0.3 * R + 0.59 * G + 0.11 * B) / 255) * Math.min(1, a) * dim[i] * (0.35 + 0.65 * ink[code]);
          if (m && k > 0) {
            const x = (i % cols) * cw + cw / 2, y = ((i / cols) | 0) * ch + ch / 2;
            if (Math.hypot(x - m.x, y - m.y) > m.r) k = 0;
          }
        }
        E[i] = k;
        RGB[i] = (R << 16) | (G << 8) | B;
      }
      // Only what outshines its surroundings glows: a firefly, a star, the rim
      // of the moon. A field of snow or a bank of pale cloud is bright all over,
      // so its own neighbourhood cancels it out instead of turning it to haze.
      const RX = 4, RY = 2;
      for (let r = 0; r < rows; r++) {
        const o = r * cols;
        let s = 0;
        for (let c = 0; c <= Math.min(RX, cols - 1); c++) s += E[o + c];
        for (let c = 0; c < cols; c++) {
          Hs[o + c] = s;
          if (c + RX + 1 < cols) s += E[o + c + RX + 1];
          if (c - RX >= 0) s -= E[o + c - RX];
        }
      }
      const area = (2 * RX + 1) * (2 * RY + 1);
      for (let c = 0; c < cols; c++) {
        let s = 0;
        for (let r = 0; r <= Math.min(RY, rows - 1); r++) s += Hs[r * cols + c];
        for (let r = 0; r < rows; r++) {
          M[r * cols + c] = s / area;
          if (r + RY + 1 < rows) s += Hs[(r + RY + 1) * cols + c];
          if (r - RY >= 0) s -= Hs[(r - RY) * cols + c];
        }
      }
      for (let i = 0; i < n; i++) {
        const k = Math.max(0, E[i] - 0.85 * M[i]);
        const rgb = RGB[i], R = rgb >>> 16, G = (rgb >>> 8) & 255, B = rgb & 255;
        // Where nothing glows the layer must be clear, not black: the canvas is
        // see-through and the page's sky colour shows behind it.
        const p = i * 4, a2 = Math.max(R, G, B) * k;
        if (a2 < 1) {
          d[p + 3] = 0;
          continue;
        }
        d[p] = (R * k * 255) / a2;
        d[p + 1] = (G * k * 255) / a2;
        d[p + 2] = (B * k * 255) / a2;
        d[p + 3] = a2;
      }
      src.getContext('2d').putImageData(this.glowData, 0, 0);

      const w = cols * cw, h = rows * ch;
      // Glow belongs to the dark. By day, sunlit cloud and grass aren't light
      // sources, so only a trace is left (enough for a campfire to still warm).
      const glow = this.glow * (1 - 0.8 * smoothstep(0.05, 0.16, bgLum));
      ctx.globalCompositeOperation = 'lighter';
      ctx.imageSmoothingEnabled = true;
      if ('filter' in ctx) {
        // A tight halo hugging the glyph and a wide soft one around it.
        ctx.globalAlpha = glow;
        ctx.filter = `blur(${(cw * 0.7).toFixed(1)}px)`;
        ctx.drawImage(src, 0, 0, w, h);
        ctx.globalAlpha = glow * 0.6;
        ctx.filter = `blur(${(cw * 2.6).toFixed(1)}px)`;
        ctx.drawImage(src, 0, 0, w, h);
        ctx.filter = 'none';
      } else {
        // No canvas filters: a quarter-size copy stretched back up is blur enough.
        const qw = Math.max(1, cols >> 2), qh = Math.max(1, rows >> 2);
        if (wide.width !== qw || wide.height !== qh) {
          wide.width = qw;
          wide.height = qh;
        }
        const wctx = wide.getContext('2d');
        wctx.clearRect(0, 0, qw, qh);
        wctx.drawImage(src, 0, 0, qw, qh);
        ctx.globalAlpha = glow * 0.9;
        ctx.drawImage(wide, 0, 0, w, h);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    /* --- frame --------------------------------------------------- */

    draw() {
      const { ctx, dpr, rows, light, glyph, gGlyph } = this;
      this.bgStyle = this.style(pack(this.bg));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      // While decoding in, rows above the wave are real, a band at the wave
      // is scrambled, and everything below it is still dark.
      const BAND = 7;
      const shown = this.reveal >= 1 ? rows : Math.floor(this.reveal * (rows + BAND)) - BAND;
      const upto = Math.max(0, Math.min(rows, shown));
      if (upto === rows) ctx.drawImage(this.groundCanvas, 0, 0);
      else if (upto > 0) {
        const hpx = Math.round(upto * this.ch * dpr);
        ctx.drawImage(this.groundCanvas, 0, 0, ctx.canvas.width, hpx, 0, 0, ctx.canvas.width, hpx);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.textSetup(ctx);

      // Ground cells inside a light are drawn again, lit, over the cached layer.
      if (this.lights.length) {
        const skip = (this.litSkip ||= new Uint8Array(0)).length === glyph.length ? this.litSkip : (this.litSkip = new Uint8Array(glyph.length));
        for (let i = 0; i < glyph.length; i++) {
          const j = i * 3;
          skip[i] = glyph[i] || !gGlyph[i] || light[j] + light[j + 1] + light[j + 2] < 0.03 ? 1 : 0;
        }
        for (let r = 0; r < upto; r++) this.drawRow(ctx, r, gGlyph, this.gColor, this.gAlpha, true, skip);
      }
      // Clear the ground under every scene cell in one pass, then draw them.
      const { cols, cw, ch } = this;
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.bgStyle;
      for (let r = 0; r < upto; r++) {
        let start = -1;
        for (let c = 0; c <= cols; c++) {
          const on = c < cols && glyph[r * cols + c] > 32;
          if (on && start < 0) start = c;
          else if (!on && start >= 0) {
            ctx.fillRect(start * cw, r * ch, (c - start) * cw, ch);
            start = -1;
          }
        }
      }
      for (let r = 0; r < upto; r++) this.drawRow(ctx, r, glyph, this.color, this.alpha, true);
      if (upto < rows) {
        this.drawScramble(ctx, Math.max(0, shown), Math.min(rows, shown + BAND));
        return;
      }
      if (this.mask) {
        // Keep only a soft-edged circle of the scene; the rest stays dark.
        const { x, y, r, soft } = this.mask;
        const m = ctx.createRadialGradient(x, y, Math.max(0, r - soft), x, y, Math.max(1, r));
        m.addColorStop(0, 'rgba(0,0,0,1)');
        m.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalCompositeOperation = 'destination-in';
        ctx.globalAlpha = 1;
        ctx.fillStyle = m;
        ctx.fillRect(0, 0, this.w, this.h);
        ctx.globalCompositeOperation = 'source-over';
      }

      if (this.glow > 0) this.drawGlow();

      // Soft bloom around each light, added on top.
      if (this.lights.length) {
        ctx.globalCompositeOperation = 'lighter';
        for (const l of this.lights) {
          if (l.r < 12) continue;
          // Under the lantern intro, only lights inside its circle glow.
          if (this.mask && Math.hypot(l.x - this.mask.x, l.y - this.mask.y) > this.mask.r) continue;
          const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r * 0.7);
          const [r, gg, b] = l.rgb;
          g.addColorStop(0, `rgba(${r},${gg},${b},${0.2 * Math.min(1, l.k)})`);
          g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      if (this.flash > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(190,205,255,${0.25 * this.flash})`;
        ctx.fillRect(0, 0, this.w, this.h);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  window.AsciiEngine = {
    TAU, clamp, rand, lerp, smoothstep, angleDiff, hash, noise, mix, pack, gradient, hexToRgb,
    strokeGlyph, popcount6, RAMP, RAMP_CODES, SUB_X, SUB_Y, mergeBoxes, Grid,
  };
})();
