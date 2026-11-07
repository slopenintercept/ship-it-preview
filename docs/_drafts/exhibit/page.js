/*
 * exhibit / page: everything around the storm.
 * Corner chrome (clock, scroll progress, found count), the glyph decode that
 * resolves each artwork into real pixels, the 9:16 loop, the two finds.
 */
(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, '0');

  /* --- chrome: clock, progress, finds ------------------------------- */

  const finds = new Set();
  const TOTAL_FINDS = 2;
  const pieces = $$('[data-piece]');
  let current = 0;

  function drawProgress() {
    const bar = '▬'.repeat(current + 1) + '─'.repeat(pieces.length - 1 - current);
    $('#prog').textContent = `scroll ${bar}  ${pad(current + 1)}/${pad(pieces.length)} · ${finds.size}/${TOTAL_FINDS} found`;
    $('#tally').textContent = finds.size === TOTAL_FINDS ? '2/2 found. you looked.' : `${finds.size}/${TOTAL_FINDS} found`;
  }

  function found(id) {
    if (finds.has(id)) return;
    finds.add(id);
    drawProgress();
  }

  function tickClock() {
    const d = new Date();
    $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())} · night`;
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const line = window.innerHeight * 0.55;
      let idx = 0;
      pieces.forEach((p, i) => { if (p.getBoundingClientRect().top < line) idx = i; });
      if (idx !== current) { current = idx; drawProgress(); }
    });
  }

  // Find 02: a small mark in the margin of the crop piece.
  function setupMarginFind() {
    const btn = $('#find-crop');
    let t = 0;
    const take = () => {
      btn.textContent = '*';
      btn.classList.add('found');
      found('crop');
    };
    btn.addEventListener('mouseenter', () => { t = setTimeout(take, 350); });
    btn.addEventListener('mouseleave', () => clearTimeout(t));
    btn.addEventListener('click', take);
    btn.addEventListener('focus', take);
  }

  /* --- the artwork decode ------------------------------------------- */

  const RAMP = ' .:-=+*#%@';
  const FONT = '"JetBrains Mono", ui-monospace, Consolas, monospace';
  const BG = '#080b14';

  // Grey glyphs for the dark parts, amber for the bright; 8 levels each.
  const greys = Array.from({ length: 8 }, (_, i) => `rgb(${70 + i * 9},${78 + i * 9},${100 + i * 10})`);
  const ambers = Array.from({ length: 8 }, (_, i) => `rgb(${150 + i * 15},${100 + i * 10},${20 + i * 2})`);

  function prepareArt(fig) {
    if (reduced) return null;
    const cv = document.createElement('canvas');
    cv.className = 'decode';
    cv.setAttribute('aria-hidden', 'true');
    fig.appendChild(cv);
    return cv;
  }

  // Paint the picture as glyphs, then let a noisy wave sweep it away to the real pixels.
  async function decode(fig, cv) {
    const img = $('img', fig);
    try { await img.decode(); } catch (e) { /* the image still shows once it loads */ }
    const W = fig.clientWidth, H = fig.clientHeight;
    if (!W || !H) { cv.remove(); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = W < 500 ? 7 : 8;
    ctx.font = `500 ${px}px ${FONT}`;
    ctx.textBaseline = 'middle';
    const cw = ctx.measureText('M').width, ch = Math.round(px * 1.25);
    const cols = Math.ceil(W / cw), rows = Math.ceil(H / ch);

    // Sample the picture down to one pixel per cell.
    let data;
    try {
      const oc = document.createElement('canvas');
      oc.width = cols; oc.height = rows;
      const octx = oc.getContext('2d');
      octx.drawImage(img, 0, 0, cols, rows);
      data = octx.getImageData(0, 0, cols, rows).data;
    } catch (e) { cv.remove(); return; }

    const n = cols * rows;
    const th = new Float32Array(n);   // when each cell resolves, 0..~1.2
    const state = new Uint8Array(n);  // 0 glyph, 1 scrambling, 2 real pixels
    const ch0 = new Uint8Array(n);    // glyph
    const sty = new Uint8Array(n);    // palette index
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c, j = i * 4;
        const L = (0.3 * data[j] + 0.59 * data[j + 1] + 0.11 * data[j + 2]) / 255;
        const lv = Math.min(9, Math.floor(L * 10));
        const q = Math.min(7, Math.floor(L * 8));
        ch0[i] = lv;
        sty[i] = L > 0.42 ? 8 + q : q;
        th[i] = (c / cols) * 0.6 + (r / rows) * 0.12 + Math.random() * 0.36;
      }
    }
    let last = '';
    for (let i = 0; i < n; i++) {
      if (!ch0[i]) continue;
      const style = sty[i] >= 8 ? ambers[sty[i] - 8] : greys[sty[i]];
      if (style !== last) { ctx.fillStyle = style; last = style; }
      ctx.fillText(RAMP[ch0[i]], (i % cols) * cw, Math.floor(i / cols) * ch + ch / 2 + 1);
    }

    const BAND = 0.1, SPAN = 1.15 + BAND, MS = 1700;
    const t0 = performance.now();
    const junk = '#%@*+=:-.01';
    let tick = 0;
    (function step(now) {
      const p = Math.min(1, (now - t0) / MS) * SPAN;
      let left = 0;
      tick++;
      for (let i = 0; i < n; i++) {
        if (state[i] === 2) continue;
        const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
        if (th[i] < p - BAND) {
          ctx.clearRect(x - 0.5, y - 0.5, cw + 1, ch + 1);
          state[i] = 2;
          continue;
        }
        left++;
        if (th[i] < p && tick % 2 === 0) {
          state[i] = 1;
          ctx.fillStyle = BG;
          ctx.fillRect(x, y, cw, ch);
          ctx.fillStyle = ambers[4 + (i % 4)];
          ctx.fillText(junk[(i * 7 + tick) % junk.length], x, y + ch / 2 + 1);
        }
      }
      if (left) requestAnimationFrame(step);
      else cv.remove();
    })(t0);
  }

  function setupArt() {
    const figs = $$('.art').map((fig) => [fig, prepareArt(fig)]).filter((p) => p[1]);
    if (!figs.length) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const hit = figs.find((p) => p[0] === e.target);
        io.unobserve(e.target);
        if (hit) decode(hit[0], hit[1]);
      }
    }, { threshold: 0.15 });
    figs.forEach((p) => io.observe(p[0]));
  }

  /* --- the 9:16 loop plays only while it is on screen ---------------- */

  function setupVideo() {
    const v = $('.reel video');
    if (!v || reduced) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      }
    }, { threshold: 0.4 });
    io.observe(v);
  }

  /* --- go ------------------------------------------------------------ */

  async function init() {
    tickClock();
    setInterval(tickClock, 15000);
    drawProgress();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    setupMarginFind();
    setupArt();
    setupVideo();

    // The scene needs the font loaded before it measures a glyph.
    try {
      await Promise.all([
        document.fonts.load('400 12px "JetBrains Mono"'),
        document.fonts.load('600 14px "JetBrains Mono"'),
      ]);
      const avoid = () => ['#storm-placard', '.chrome.tl', '.chrome.tr', '.chrome.bl', '.chrome.br']
        .map((s) => $(s).getBoundingClientRect());
      window.ShipStorm.mount($('#storm'), { avoid, reduced, onFound: () => found('storm') });
    } catch (err) {
      $('#storm').remove();
      console.warn('storm unavailable', err);
    }
  }

  init();
})();
