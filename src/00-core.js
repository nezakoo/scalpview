// Core: SB global, config, event bus, utils, UI helpers, hotkeys.
(function () {
  'use strict';
  const SB = (window.SB = window.SB || {});
  const $ = (s, el = document) => el.querySelector(s);

  // ---------- config ----------
  const CFG_KEY = 'sb.cfg2'; // bumped with the ScalpBoard-look defaults
  try { SB.cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { SB.cfg = {}; }
  let saveTimer = null;
  SB.saveCfg = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => localStorage.setItem(CFG_KEY, JSON.stringify(SB.cfg)), 200);
  };
  SB.defaults = (ns, obj) => {
    if (ns == null) { for (const k in obj) if (!(k in SB.cfg)) SB.cfg[k] = obj[k]; return SB.cfg; }
    SB.cfg[ns] = Object.assign({}, obj, SB.cfg[ns] || {});
    return SB.cfg[ns];
  };

  // ---------- events ----------
  const handlers = {};
  SB.on = (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); };
  SB.off = (evt, fn) => { handlers[evt] = (handlers[evt] || []).filter(f => f !== fn); };
  SB.emit = (evt, data) => {
    for (const fn of handlers[evt] || []) {
      try { fn(data); } catch (e) { console.error('handler', evt, e); }
    }
  };
  const inits = [];
  SB.init = fn => inits.push(fn);

  // ---------- utils ----------
  const decimals = tick => {
    if (!tick || tick >= 1) return 0;
    const s = String(tick);
    if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
    return (s.split('.')[1] || '').replace(/0+$/, '').length;
  };
  // Request scheduler: max requests/sec, optional weight budget per minute, priority queue,
  // and a pause() used on HTTP 429/418. run(fn, {weight, prio}) — higher prio runs first.
  class RateLimiter {
    constructor(perSec, weightPerMin = 0) {
      Object.assign(this, { gap: 1000 / perSec, weightPerMin, q: [], last: 0, used: [], pausedUntil: 0, timer: null });
    }
    run(fn, opts = {}) {
      return new Promise((resolve, reject) => {
        this.q.push({ fn, resolve, reject, w: opts.weight || 1, prio: opts.prio || 0, seq: (this.seq = (this.seq || 0) + 1) });
        this.q.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
        this.pump();
      });
    }
    pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
    usedWeight() { const now = Date.now(); this.used = this.used.filter(u => now - u[0] < 60000); return this.used.reduce((s, u) => s + u[1], 0); }
    pump() {
      if (this.timer || !this.q.length) return;
      const now = Date.now();
      let wait = Math.max(this.pausedUntil - now, this.last + this.gap - now, 0);
      if (!wait && this.weightPerMin && this.usedWeight() + this.q[0].w > this.weightPerMin) wait = 1000;
      if (wait) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait); return; }
      const job = this.q.shift();
      this.last = now;
      this.used.push([now, job.w]);
      Promise.resolve().then(job.fn).then(job.resolve, job.reject);
      this.pump();
    }
  }
  SB.util = {
    decimals,
    fmtPrice(p, tick) {
      if (p == null || !isFinite(p)) return '—';
      let d = tick ? decimals(tick) : (p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 8);
      return p.toFixed(Math.min(d, 10));
    },
    fmtUsd(v) {
      if (v == null || !isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
      if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
      if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
      return v.toFixed(0);
    },
    fmtPct(v, d = 2) { return v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%'; },
    fmtNum(v, d = 2) { return v == null || !isFinite(v) ? '—' : v.toFixed(d); },
    parseUsd(s) {
      const m = String(s).trim().toUpperCase().replace(/[$,\s]/g, '').match(/^([\d.]+)([KMB]?)$/);
      if (!m) return null;
      return parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1);
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    throttle(fn, ms) {
      let last = 0, t = null;
      return (...a) => {
        const now = Date.now();
        if (now - last >= ms) { last = now; fn(...a); }
        else if (!t) t = setTimeout(() => { t = null; last = Date.now(); fn(...a); }, ms - (now - last));
      };
    },
    esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    RateLimiter,
  };
  SB.$ = $;

  // ---------- UI helpers ----------
  SB.ui = {};
  // tiny stroke icons (fonts differ per machine, so no unicode symbols)
  const ICONS = {
    chg: '<path d="M2 11l4-4 3 3 5-6"/><path d="M10 4h4v4"/>',
    range: '<path d="M3 13L13 3"/><path d="M8 3h5v5"/><path d="M8 13H3V8"/>',
    natr: '<path d="M9 1L3 9h4l-1 6 6-8H8z"/>',
    vol: '<path d="M3 14V9M7 14V4M11 14V7M15 14V11"/>',
    corr: '<path d="M1 9c2-5 4-5 6 0s4 5 6 0 2-3 2-3"/>',
    trades: '<path d="M5 2L4 14M11 2l-1 12M2 6h12M2 10h12"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
    full: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>',
    list: '<path d="M2 4h12M2 8h12M2 12h12"/>',
    map: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 8h12M6 2v12"/>',
    filter: '<path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z"/>',
    grid: '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
    sortd: '<path d="M4 2v12M1.5 11.5L4 14l2.5-2.5M9 4h6M9 8h4.5M9 12h3"/>',
    sortu: '<path d="M4 14V2M1.5 4.5L4 2l2.5 2.5M9 4h3M9 8h4.5M9 12h6"/>',
    bell: '<path d="M4 11V7a4 4 0 018 0v4l1.5 1.5h-11zM6.5 14h3"/>',
    bolt: '<path d="M9 1L3 9h4l-1 6 6-8H8z"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
    focus: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>',
  };
  SB.icon = (name, size = 12) => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  SB.ui.exTag = id => `<span class="ex ${id}">${id}</span>`;
  SB.ui.toast = (text, kind = 'info', opts = {}) => {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = text;
    el.onclick = () => { if (opts.onClick) opts.onClick(); el.remove(); };
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), opts.ttl || 8000);
    const all = $('#toasts').children;
    while (all.length > 6) all[0].remove();
    return el;
  };

  const panels = [];
  SB.ui.DOCK = ['density']; // panels stacked under the coin list, like ScalpBoard
  SB.ui.addPanel = ({ id, title, icon, el, width }) => {
    const p = document.createElement('div');
    p.className = 'panel hidden';
    p.id = 'panel-' + id;
    if (width) p.style.width = width + 'px';
    const svg = { density: 'map', impulses: 'bolt', alerts: 'bell', funding: 'clock' }[id];
    p.innerHTML = `<div class="panel-head">${svg ? SB.icon(svg, 13) : icon || ''} ${title}</div><div class="panel-body"></div>`;
    p.querySelector('.panel-body').appendChild(el);
    const docked = SB.ui.DOCK.includes(id);
    (docked ? $('#side-dock') : $('#panels')).appendChild(p);
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.title = title;
    if (svg) b.innerHTML = SB.icon(svg, 15); else b.textContent = icon || title[0];
    $('#rtb').appendChild(b);
    const open = (SB.cfg.openPanels || SB.ui.DOCK).includes(id);
    const set = on => {
      p.classList.toggle('hidden', !on);
      b.classList.toggle('on', on);
      const s = new Set(SB.cfg.openPanels || []);
      on ? s.add(id) : s.delete(id);
      SB.cfg.openPanels = [...s];
      SB.saveCfg();
      SB.emit('panel', { id, open: on });
      window.dispatchEvent(new Event('resize'));
    };
    b.onclick = () => set(p.classList.contains('hidden'));
    if (open) { p.classList.remove('hidden'); b.classList.add('on'); }
    panels.push({ id, p, b, set });
    return { panel: p, body: p.querySelector('.panel-body'), set, isOpen: () => !p.classList.contains('hidden') };
  };

  const settingsTabs = [];
  SB.ui.addSettings = tab => settingsTabs.push(tab);
  SB.ui.openSettings = (id) => {
    const tabs = $('#settings-tabs'), body = $('#settings-body');
    tabs.innerHTML = '';
    const show = t => {
      [...tabs.children].forEach(d => d.classList.toggle('on', d.dataset.id === t.id));
      body.innerHTML = '';
      const h = document.createElement('h3'); h.textContent = t.title; body.appendChild(h);
      const box = document.createElement('div'); body.appendChild(box);
      try { t.render(box); } catch (e) { console.error(e); box.textContent = String(e); }
    };
    for (const t of settingsTabs) {
      const d = document.createElement('div');
      d.textContent = t.title; d.dataset.id = t.id;
      d.onclick = () => show(t);
      tabs.appendChild(d);
    }
    $('#settings').classList.remove('hidden');
    show(settingsTabs.find(t => t.id === id) || settingsTabs[0]);
  };
  SB.ui.closeSettings = () => { $('#settings').classList.add('hidden'); SB.emit('settings:closed'); };

  // Small form builder for settings tabs: SB.ui.field(box, label, obj, key, type, opts)
  SB.ui.field = (box, label, obj, key, type = 'text', opts = {}) => {
    const row = document.createElement('div');
    row.className = 'srow';
    const l = document.createElement('label'); l.textContent = label; row.appendChild(l);
    let inp;
    if (type === 'select') {
      inp = document.createElement('select');
      for (const o of opts.options) {
        const [v, t] = Array.isArray(o) ? o : [o, o];
        const op = document.createElement('option'); op.value = v; op.textContent = t; inp.appendChild(op);
      }
      inp.value = obj[key];
    } else if (type === 'checkbox') {
      inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!obj[key];
    } else {
      inp = document.createElement('input'); inp.type = type; inp.value = obj[key] ?? '';
      if (opts.wide) inp.className = 'wide';
      if (opts.step) inp.step = opts.step;
    }
    inp.onchange = () => {
      let v = type === 'checkbox' ? inp.checked : inp.value;
      if (type === 'number') v = parseFloat(v);
      if (type === 'select' && opts.numeric) v = parseFloat(v);
      obj[key] = v;
      SB.saveCfg();
      if (opts.onChange) opts.onChange(v);
    };
    row.appendChild(inp);
    if (opts.hint) { const h = document.createElement('span'); h.className = 'dim'; h.textContent = opts.hint; row.appendChild(h); }
    box.appendChild(row);
    return inp;
  };

  // ---------- terminals ----------
  SB.defaults('terminal', {
    kind: 'vataga', button: 'right',
    tmpl: { vataga: 'vataga://{SYM}', metascalp: 'metascalp://open?symbol={SYM}&exchange={EXNAME}', tiger: 'tigertrade://symbol/{SYM}', custom: '' },
  });
  SB.ui.openTerminal = (key, ex, opts = {}) => {
    const coin = SB.coin(key);
    if (!coin) return;
    const t = SB.cfg.terminal;
    const id = opts.exact && ex && coin.src[ex] ? ex : coin.ex;
    const s = coin.src[id];
    const tmpl = t.tmpl[t.kind];
    if (!tmpl) { SB.ui.toast('Set a terminal URL in Settings → Terminals', 'warn'); return; }
    const exName = { 'BI-F': 'BinanceFutures', 'BI-S': 'Binance', 'BY-F': 'BybitFutures', 'BY-S': 'Bybit', 'OK-F': 'OkxFutures', 'OK-S': 'Okx' }[id];
    const url = tmpl.replace('{SYM}', SB.ex[id].termSym(s.sym)).replace('{EX}', id).replace('{EXNAME}', exName).replace('{BASE}', coin.base);
    const a = document.createElement('a'); a.href = url; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    SB.ui.toast(`${coin.key} ${SB.ui.exTag(id)} → ${t.kind}`, 'info', { ttl: 1500 });
  };
  // Is this mouse event the "open in terminal" click?
  SB.ui.isTermClick = e => (SB.cfg.terminal.button === 'middle' ? e.button === 1 : e.button === 2) && !e.shiftKey;

  // ---------- hotkeys ----------
  const hot = {};
  SB.hoverCtx = null;
  SB.hotkey = (combo, fn) => { (hot[combo.toLowerCase()] = hot[combo.toLowerCase()] || []).push(fn); };
  const comboOf = e => {
    let k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    if (e.code && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase(); // layout independent
    if (e.code && /^Digit\d$/.test(e.code)) k = e.code.slice(5);
    if (k === ' ') k = 'space';
    return (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + k;
  };
  SB.comboOf = comboOf;
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const combo = comboOf(e);
    const fns = hot[combo];
    if (fns && fns.length) {
      e.preventDefault();
      for (const fn of fns) { try { if (fn(e, SB.hoverCtx) === false) break; } catch (err) { console.error(err); } }
      return;
    }
    if (SB.onUnhandledKey) SB.onUnhandledKey(e, combo);
  });

  // ---------- start ----------
  SB.start = async () => {
    for (const fn of inits) { try { await fn(); } catch (e) { console.error('init', e); } }
    SB.emit('ready');
    if (SB.loadData) SB.loadData();
  };
  document.addEventListener('DOMContentLoaded', () => SB.start());
})();
