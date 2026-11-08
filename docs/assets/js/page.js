/*
 * product / page: the tabs (auto-advance, arrows, aria) and the install notes dialog.
 */
(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
  const cap = document.getElementById('cap');
  const viewName = document.getElementById('view-name');
  const region = document.querySelector('.product');
  const ADVANCE_MS = 7000;
  const FADE_MS = 300;

  let current = 0;
  let timer = 0;
  let manual = false; // the visitor chose a tab: stop auto-advancing for good
  let hovering = false;
  let fadeTimer = 0;

  function show(n) {
    if (n === current) return;
    const prev = panels[current], next = panels[n];
    current = n;
    tabs.forEach((t, i) => {
      t.setAttribute('aria-selected', i === n ? 'true' : 'false');
      t.tabIndex = i === n ? 0 : -1;
    });
    cap.textContent = next.dataset.cap;
    viewName.textContent = tabs[n].dataset.view;
    clearTimeout(fadeTimer);
    panels.forEach((p) => { if (p !== prev && p !== next) { p.classList.remove('is-on'); p.hidden = true; } });
    if (reduced) {
      prev.classList.remove('is-on'); prev.hidden = true;
      next.hidden = false; next.classList.add('is-on');
      return;
    }
    next.hidden = false;
    void next.offsetWidth; // let the opacity transition start from 0
    next.classList.add('is-on');
    prev.classList.remove('is-on');
    fadeTimer = setTimeout(() => { prev.hidden = true; }, FADE_MS);
  }

  function schedule() {
    clearTimeout(timer);
    if (reduced || manual || hovering || document.hidden) return;
    timer = setTimeout(() => { show((current + 1) % tabs.length); schedule(); }, ADVANCE_MS);
  }

  function choose(n, focus) {
    manual = true;
    clearTimeout(timer);
    show(n);
    if (focus) tabs[n].focus();
  }

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => choose(i, false));
    t.addEventListener('keydown', (e) => {
      let n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = tabs.length - 1;
      if (n < 0) return;
      e.preventDefault();
      choose(n, true);
    });
  });

  region.addEventListener('pointerenter', () => { hovering = true; clearTimeout(timer); });
  region.addEventListener('pointerleave', () => { hovering = false; schedule(); });
  document.addEventListener('visibilitychange', schedule);
  // Hold the tabs still until the startup intro has handed the page over.
  if (document.documentElement.classList.contains('intro')) document.addEventListener('shipit:intro-done', schedule, { once: true });
  else schedule();

  /* --- install notes ------------------------------------------------ */

  const dlg = document.getElementById('notes');
  const openBtn = document.getElementById('open-notes');
  const closeBtn = document.getElementById('close-notes');

  openBtn.addEventListener('click', () => { dlg.showModal(); closeBtn.focus(); });
  closeBtn.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => openBtn.focus());
})();
