/*
 * ascii-weather — time of day and weather for glyph scenes.
 *
 * Environment follows the visitor's local clock: night is night on the site.
 * Weather changes every 20 minutes and is picked from the date, so everyone
 * visiting at the same time shares the sky. Every value eases; nothing jumps.
 * It also simulates the precipitation particles and lightning.
 *
 * URL overrides for demos: ?time=dawn|day|dusk|night, ?hour=14.5,
 * ?weather=clear|cloudy|rain|storm|fog|snow.
 *
 * Exposes window.AsciiWeather = { Environment, WEATHERS }. Requires engine.js.
 */
(function () {
  'use strict';

  const { clamp, rand, smoothstep, hash, noise } = window.AsciiEngine;

  const WEATHERS = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow'];
  const TARGETS = {
    clear: { cloud: 0.12, wet: 0, storm: 0, fog: 0, snow: 0 },
    cloudy: { cloud: 0.72, wet: 0, storm: 0, fog: 0, snow: 0 },
    rain: { cloud: 0.85, wet: 0.75, storm: 0, fog: 0.15, snow: 0 },
    storm: { cloud: 1, wet: 1, storm: 1, fog: 0, snow: 0 },
    fog: { cloud: 0.35, wet: 0, storm: 0, fog: 1, snow: 0 },
    snow: { cloud: 0.7, wet: 0, storm: 0, fog: 0.1, snow: 1 },
  };
  const KEYS = Object.keys(TARGETS.clear);
  const PRESET_HOURS = { dawn: 6.4, day: 13, dusk: 17.7, night: 23 };
  const SLOT_MS = 20 * 60 * 1000;

  class Environment {
    constructor() {
      const q = new URLSearchParams(location.search);
      this.fixedHour = q.has('hour') ? +q.get('hour') : PRESET_HOURS[q.get('time')] ?? null;
      this.fixedWeather = WEATHERS.includes(q.get('weather')) ? q.get('weather') : null;
      this.hour = this.clockHour();
      this.weather = this.fixedWeather || this.scheduled();
      Object.assign(this, TARGETS[this.weather]);
      this.wind = rand(-0.35, 0.35);
      this.drops = [];
      this.splashes = [];
      this.bolts = [];
      this.flash = 0;
      this.nextBolt = rand(3, 8);
      this.nextCheck = 10;
      this.time = 0;
      this.overrides = {}; // demo: fixed values for cloud/wet/fog/snow
      this.windLock = null; // demo: a fixed wind
      this.fastUntil = 0; // demo: changes ease in quickly until then
      this.updateSun();
    }

    /* --- demo controls ---------------------------------------------- */

    // A fixed hour (0..24), or null to follow the visitor's clock again.
    setHour(h) {
      this.fixedHour = h == null ? null : h;
      this.hour = this.clockHour();
      this.updateSun();
    }

    // A fixed weather, or null to go back to the schedule. Clears fine-tuning.
    setWeather(name) {
      this.fixedWeather = WEATHERS.includes(name) ? name : null;
      this.weather = this.fixedWeather || this.scheduled();
      this.overrides = {};
      this.hurry();
    }

    // Fine-tune one value (cloud, wet, fog, snow) on top of the weather.
    override(key, value) {
      if (!KEYS.includes(key)) return;
      if (value == null) delete this.overrides[key];
      else this.overrides[key] = clamp(value, 0, 1);
      this.hurry();
    }

    setWind(v) {
      this.windLock = v == null ? null : clamp(v, -0.8, 0.8);
      if (v != null) this.wind = this.windLock;
    }

    hurry() {
      this.fastUntil = this.time + 2.5;
    }

    target(key) {
      return key in this.overrides ? this.overrides[key] : TARGETS[this.weather][key];
    }

    clockHour() {
      if (this.fixedHour != null && Number.isFinite(this.fixedHour)) return ((this.fixedHour % 24) + 24) % 24;
      const d = new Date();
      return d.getHours() + d.getMinutes() / 60;
    }

    // The same weather for everyone in the same 20-minute slot of the day.
    scheduled() {
      const d = new Date();
      const month = d.getMonth();
      const winter = month === 11 || month <= 1;
      const weights = winter
        ? { clear: 30, cloudy: 26, rain: 0, storm: 0, fog: 16, snow: 28 }
        : { clear: 36, cloudy: 24, rain: 18, storm: 8, fog: 14, snow: 0 };
      let r = hash(Math.floor(d.getTime() / SLOT_MS), 7, 3) * 100;
      for (const w of WEATHERS) if ((r -= weights[w]) <= 0) return w;
      return 'clear';
    }

    // Demo control: step through every weather, then back to the schedule.
    cycle() {
      const i = WEATHERS.indexOf(this.fixedWeather ?? this.weather);
      this.fixedWeather = WEATHERS[(i + 1) % WEATHERS.length];
      this.weather = this.fixedWeather;
      return this.weather;
    }

    updateSun() {
      const h = this.hour;
      this.sunAlt = Math.sin((Math.PI * (h - 6)) / 12); // > 0 by day
      this.moonAlt = -this.sunAlt;
      this.day = smoothstep(-0.12, 0.3, this.sunAlt);
      // Warm light only near sunrise and sunset.
      this.warm = 1 - smoothstep(0.04, 0.42, Math.abs(this.sunAlt));
      this.sunT = (h - 6) / 12; // 0 at sunrise, 1 at sunset
      this.moonT = (((h - 18) % 24) + 24) % 24 / 12;
      this.phase = this.day > 0.75 ? 'day' : this.day < 0.12 ? 'night' : h < 12 ? 'dawn' : 'dusk';
    }

    // Plain summary for the page: clock, phase, weather, background colour.
    summary() {
      const hh = Math.floor(this.hour), mm = Math.floor((this.hour - hh) * 60);
      return { clock: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, phase: this.phase, weather: this.weather };
    }

    step(dt, w, h, hz) {
      this.time += dt;
      this.nextCheck -= dt;
      if (this.nextCheck < 0) {
        this.nextCheck = 10;
        this.hour = this.clockHour();
        this.updateSun();
        if (!this.fixedWeather) this.weather = this.scheduled();
      }
      // Weather fronts take ~10 s to roll in; demo changes take ~1 s.
      const k = Math.min(1, dt / (this.time < this.fastUntil ? 0.8 : 10));
      for (const key of KEYS) this[key] += (this.target(key) - this[key]) * k;
      if (this.windLock != null) this.wind = this.windLock;
      else this.wind = clamp(this.wind + (noise(this.time * 0.05, 3, 77) - 0.5) * dt * 0.2, -0.6, 0.6);
      this.stepPrecip(dt, w, h, hz);
      this.stepLightning(dt, w, h, hz);
    }

    stepPrecip(dt, w, h, hz) {
      const area = clamp((w * h) / 1500, 120, 800);
      const want = Math.round(area * Math.max(this.wet, this.snow * 0.8));
      const kind = this.snow > this.wet ? 'snow' : 'rain';
      while (this.drops.length < want) this.drops.push(this.spawn(kind, w, h, hz, true));
      if (this.drops.length > want) this.drops.length = want;
      const t = this.time;
      for (let i = 0; i < this.drops.length; i++) {
        const d = this.drops[i];
        if (d.kind === 'rain') {
          d.x += d.vx * dt;
          d.y += d.vy * dt;
        } else {
          d.x += (d.vx + Math.sin(t * 1.3 + d.seed) * 14) * dt;
          d.y += d.vy * dt;
        }
        if (d.y >= d.land) {
          if (d.kind === 'rain' && this.splashes.length < 160) this.splashes.push({ x: d.x, y: d.land, born: t, depth: d.depth });
          this.drops[i] = this.spawn(kind, w, h, hz, false);
        }
      }
      this.splashes = this.splashes.filter((s) => t - s.born < 0.3);
    }

    // Drops land at a random depth in the clearing; nearer ones fall faster.
    spawn(kind, w, h, hz, anywhere) {
      const land = rand(hz - 20, h);
      const depth = clamp((land - hz) / (h - hz), 0, 1);
      const rain = kind === 'rain';
      const vy = rain ? 620 + 380 * depth : 30 + 55 * depth;
      return {
        kind, land, depth, seed: rand(0, 100),
        x: rand(-60, w + 60), y: anywhere ? rand(-40, land) : rand(-60, -5),
        vy, vx: this.wind * (rain ? 260 : 40),
      };
    }

    stepLightning(dt, w, h, hz) {
      const t = this.time;
      this.flash *= Math.exp(-dt * 9);
      this.bolts = this.bolts.filter((b) => t - b.born < 0.35);
      if (this.storm < 0.5) return;
      this.nextBolt -= dt;
      if (this.nextBolt > 0) return;
      this.nextBolt = rand(5, 13);
      this.strike(w, h, hz);
    }

    // A jagged bolt from the clouds to the ground.
    strike(w, h, hz) {
      const t = this.time;
      const pts = [];
      let x = rand(w * 0.1, w * 0.9), y = -10;
      const ground = rand(hz + 20, h * 0.75);
      while (y < ground) {
        pts.push([x, y]);
        x += rand(-28, 28);
        y += rand(18, 40);
      }
      pts.push([x, ground]);
      this.bolts.push({ pts, born: t });
      this.flash = 1;
    }
  }

  window.AsciiWeather = { Environment, WEATHERS };
})();
