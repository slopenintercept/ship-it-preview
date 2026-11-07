/*
 * page.js: everything around the storm. Boot intro, HUD, scroll veil, the glyph
 * decode on screenshots, the click-to-strike, and the one small secret.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  };

  /* ---------------------------------------------------------- HUD */

  // Tick-bar meter: `|||||.....`, filled ticks in amber.
  function setBar(el, n) {
    const total = +el.dataset.ticks || 10;
    n = clamp(Math.round(n), 0, total);
    el.textContent = '';
    el.append('|'.repeat(n));
    const rest = document.createElement('i');
    rest.textContent = '.'.repeat(total - n);
    el.append(rest);
  }

  let toastTimer = 0;
  function toast(tag, text) {
    const t = $('#toast');
    t.textContent = '';
    const s = document.createElement('span');
    s.className = 'tag';
    s.textContent = tag;
    t.append(s, text);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
  }

  /* ---------------------------------------------------------- glyph decode */

  // A screenshot arrives as glyphs first: colour-sampled characters wash down it, then the real pixels fade in.
  const RAMP = ' .:-=+*#%@';
  const SCRAMBLE = '#%&@*+=!/\\|<>~^:;';

  function showReal(fig) {
    fig.classList.add('done');
    const v = $('video', fig);
    if (v && !reduced) v.play().catch(() => {});
  }

  function decodeFigure(fig) {
    const cv = $('canvas.glyphs', fig);
    const img = $('img', fig);
    const url = img ? img.currentSrc || img.src : fig.dataset.poster;
    if (reduced || !cv || !url) return showReal(fig);
    const im = new Image();
    im.onerror = () => showReal(fig);
    im.onload = () => {
      const rect = fig.getBoundingClientRect();
      const W = Math.round(rect.width), H = Math.round(rect.height);
      if (W < 20 || H < 8) return showReal(fig);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = W < 480 ? 5 : 6;
      const mk = () => {
        const c = document.createElement('canvas');
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
        const x = c.getContext('2d');
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        x.font = `600 ${px}px "JetBrains Mono", monospace`;
        x.textBaseline = 'middle';
        return [c, x];
      };
      const [layer, lx] = mk();
      const cw = lx.measureText('M').width, ch = Math.round(px * 1.22);
      const cols = Math.max(1, Math.floor(W / cw)), rows = Math.max(1, Math.floor(H / ch));
      // sample the picture at one pixel per cell
      const sm = document.createElement('canvas');
      sm.width = cols;
      sm.height = rows;
      const sx = sm.getContext('2d', { willReadFrequently: true });
      sx.drawImage(im, 0, 0, cols, rows);
      let px8;
      try { px8 = sx.getImageData(0, 0, cols, rows).data; } catch (e) { return showReal(fig); }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const p = (r * cols + c) * 4;
          const R = px8[p], G = px8[p + 1], B = px8[p + 2];
          const lum = (0.3 * R + 0.59 * G + 0.11 * B) / 255;
          const k = Math.min(9, Math.floor(Math.pow(lum, 0.55) * 9.99));
          if (k < 1) continue;
          const boost = 1 + (1 - lum) * 1.3; // dark UI would vanish otherwise
          lx.fillStyle = `rgb(${Math.min(255, R * boost + 20) | 0},${Math.min(255, G * boost + 20) | 0},${Math.min(255, B * boost + 20) | 0})`;
          lx.fillText(RAMP[k], c * cw, r * ch + ch / 2 + 1);
        }
      }
      // the wave
      cv.width = layer.width;
      cv.height = layer.height;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = lx.font;
      ctx.textBaseline = 'middle';
      const BAND = 6, dur = rows > 24 ? 1300 : 800;
      const t0 = performance.now();
      const tick = (now) => {
        const f = clamp((now - t0) / dur, 0, 1);
        const shown = Math.floor(f * (rows + BAND)) - BAND;
        const upto = clamp(shown, 0, rows);
        ctx.clearRect(0, 0, W, H);
        if (upto > 0) ctx.drawImage(layer, 0, 0, layer.width, Math.round(upto * ch * dpr), 0, 0, W, upto * ch);
        ctx.fillStyle = '#ffb020';
        ctx.globalAlpha = 0.8;
        for (let r = Math.max(0, shown); r < Math.min(rows, shown + BAND); r++) {
          for (let c = 0; c < cols; c += 1) {
            if (Math.random() < 0.55) continue;
            ctx.fillText(SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0], c * cw, r * ch + ch / 2 + 1);
          }
        }
        ctx.globalAlpha = 1;
        if (f < 1) requestAnimationFrame(tick);
        else setTimeout(() => showReal(fig), 140);
      };
      requestAnimationFrame(tick);
    };
    im.src = url;
  }

  function watchFigures() {
    const figs = $$('figure[data-decode]');
    if (reduced || !('IntersectionObserver' in window)) return figs.forEach(showReal);
    const seen = new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        seen.unobserve(e.target);
        decodeFigure(e.target);
      }
    }, { threshold: 0.2 });
    figs.forEach((f) => seen.observe(f));
    // the loop only plays while it is on screen
    const v = $('video');
    if (v) {
      new IntersectionObserver(([e]) => {
        if (!$('.well.done video')) return;
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      }).observe(v);
    }
  }

  /* ---------------------------------------------------------- boot */

  const BOOT = [
    ['> loading installer ', '...... ', '284 mb'],
    ['> presets: ', 'tiktok, shorts, reels, youtube, discord'],
    ['> exports: ', 'mp4 · 9:16 · mp3 · gif'],
    ['> timeline: ', 'video, photos, sound, titles, stickers'],
    ['> fps: ', 'original, 24, 30, 60, 120'],
    ['> trackers ', '...... ', 'none'],
    ['> sky: ', 'night · rain'],
    ['> calling the strike ', 'ok'],
  ];

  function runBoot(done) {
    const boot = $('#boot'), log = $('#boot-log');
    boot.hidden = false;
    let i = 0, finished = false, timer = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('keydown', finish);
      boot.removeEventListener('pointerdown', finish);
      boot.classList.add('gone');
      setTimeout(() => (boot.hidden = true), 600);
      done();
    };
    window.addEventListener('keydown', finish);
    boot.addEventListener('pointerdown', finish);
    const next = () => {
      if (finished) return;
      if (i >= BOOT.length) return (timer = setTimeout(finish, 420));
      const line = document.createElement('div');
      BOOT[i].forEach((part, k) => {
        const s = document.createElement('span');
        s.textContent = part;
        // the last piece of a line is the number or answer: bright, and amber for the final ok
        if (k === BOOT[i].length - 1 && k > 0) s.className = part === 'ok' ? 'ok' : 'v';
        line.append(s);
      });
      log.append(line);
      i++;
      timer = setTimeout(next, 250);
    };
    next();
  }

  /* ---------------------------------------------------------- go */

  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

  async function main() {
    const seenKey = 'shipit.world.boot';
    const intro = !reduced && store.get(seenKey) === null && store.set(seenKey, '1');
    if (!intro) root.classList.remove('booting');

    try {
      await withTimeout(Promise.all([document.fonts.load('400 12px "JetBrains Mono"'), document.fonts.load('600 12px "JetBrains Mono"')]), 2500);
    } catch (e) { /* fall back to the system mono */ }

    // chrome that doesn't need the scene
    $$('.bar[data-ticks]:not(#charge)').forEach((b) => setBar(b, 10));
    const found = { n: store.get('shipit.world.found') === '1' ? 1 : 0 };
    const paintFound = () => {
      const f = $('#found');
      f.textContent = `${found.n}/1 found`;
      f.classList.toggle('yes', found.n > 0);
    };
    paintFound();
    watchFigures();

    const storm = window.ShipItStorm.mount($('#scene'), { reduced });

    // dim the storm behind the hero copy; tracks the copy while it scrolls, in coarse steps
    let boxY = null;
    const measure = (force) => {
      const y = window.scrollY;
      if (!force && boxY !== null && Math.abs(y - boxY) < 24) return;
      boxY = y;
      const b = $('.hero-copy').getBoundingClientRect();
      storm.setAvoid(b.bottom < 0 ? [] : [{ left: b.left, top: b.top, right: b.right, bottom: b.bottom }]);
    };
    measure(true);
    new ResizeObserver(() => measure(true)).observe($('.hero-copy'));
    window.addEventListener('resize', () => measure(true));

    // scroll: veil darkens the storm, nav follows, scene drops to half rate far below the fold
    const veil = $('#veil');
    const navKeys = [['top', 'top'], ['rec', null], ['home', null], ['cut', 'cut'], ['ship', 'ship'], ['install', 'install']];
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const vh = window.innerHeight, y = window.scrollY;
        veil.style.opacity = (clamp(y / (vh * 0.85), 0, 1) * 0.72).toFixed(3);
        storm.lowRate = y > vh * 1.4;
        let active = 'top';
        for (const [id, nav] of navKeys) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top < vh * 0.45) active = nav;
        }
        $$('nav a').forEach((a) => (a.dataset.nav === active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
        measure(false);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // live HUD: sky row and the strike charge meter
    const sky = $('#sky'), charge = $('#charge');
    const hud = () => {
      const d = new Date();
      sky.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · night · ${storm.env.weather}`;
    };
    hud();
    setInterval(hud, 15000);
    setBar(charge, 0);
    if (!reduced) setInterval(() => setBar(charge, storm.charge * 10), 250);
    else setBar(charge, 10);

    // the secret: catch a natural strike with a click, or the old code
    const discover = (how) => {
      if (found.n) return;
      found.n = 1;
      store.set('shipit.world.found', '1');
      paintFound();
      toast('[found]', how + ' · 1/1');
      for (let k = 0; k < 3; k++) setTimeout(() => storm.strike(storm.g.w * (0.2 + 0.3 * k + Math.random() * 0.1), storm.hz + 40 + 80 * k, true), 160 * k);
    };
    window.addEventListener('click', (e) => {
      if (e.target.closest('a, button, #boot')) return;
      if (String(window.getSelection() || '')) return;
      const live = storm.catchable();
      if (live) discover('you caught a strike');
      else storm.call(e.clientX, e.clientY);
    });
    const code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let at = 0;
    window.addEventListener('keydown', (e) => {
      at = e.key === code[at] ? at + 1 : e.key === code[0] ? 1 : 0;
      if (at === code.length) { at = 0; discover('the old code still works'); }
    });

    storm.start();
    if (intro) runBoot(() => { root.classList.remove('booting'); storm.reveal(2.6); });
    else storm.reveal(1.2);
  }

  main();
})();
