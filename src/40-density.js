/* 40-density.js: order book wall (density) scanner, density map panel, density lines on charts.
 *
 * Scanner: one worker loop per exchange. Each loop spends a fixed request-weight budget per minute
 * (BUDGET below; BI-F stays at 1000 of Binance's 2400/min because core needs the rest) and picks the
 * next coin from SB.list: every other slot goes to a coin visible on the board / in focus whose last
 * scan is older than fastSec, the rest rotates through the list (never scanned first, top first, then
 * oldest scan). A full list refresh takes ~1-2 min per exchange.
 *
 * BRP (base density size), one per coin:
 *   auto:   BRP = max(autoMin, maxVol24 / 1440 * autoMinutes), maxVol24 = largest 24h USDT volume among the
 *           coin's sources. I.e. "autoMinutes" minutes of the coin's average traded volume on its main
 *           market, with a floor so thin coins don't flag every level (default 3 min, floor $100K:
 *           BTC with ~$8B/24h on BI-F -> BRP ~$17M, small wall >= $34M). Using the max source (not each
 *           exchange's own volume) keeps market-maker ladders on thin secondary books from all flagging.
 *   manual: one USDT value for all coins.
 *   per-coin override (cfg.density.override[key]) wins over both.
 * Categories: size >= BRP x mult[0|1|2] -> small|medium|large. Walls younger than minLife seconds are
 * shown one category lower (and marked "young"), so fresh spoof orders do not look like solid walls.
 * Walls are tracked across scans by (coin, exchange, side, price +- tick); size may change.
 * Round number: price is a multiple of half of the second significant digit (67500, 0.0455, 1.25).
 */
(function () {
  'use strict';
  const SB = window.SB;
  if (!SB) return;

  const MAXDEPTH = 10;            // walls are stored up to 10% away; display filters by cfg depth
  const STALE_MS = 5 * 60e3;      // drop walls not confirmed for this long (book truncated / not rescanned)
  // per exchange: depth levels requested, request weight, weight budget per minute
  const BUDGET = {
    'BI-F': { limit: 500, weight: 10, perMin: 1000 },
    'BI-S': { limit: 500, weight: 25, perMin: 2400 },
    'BY-F': { limit: 500, weight: 1, perMin: 180 },
    'BY-S': { limit: 200, weight: 1, perMin: 180 },
    'OK-F': { limit: 400, weight: 1, perMin: 180 },
    'OK-S': { limit: 400, weight: 1, perMin: 180 },
  };
  const CATS = ['small', 'medium', 'large'];

  const walls = new Map();        // id -> wall
  const books = new Map();        // key|ex -> {t, ids:Set, lo, hi}  (lo/hi = price range the book covered)
  const stats = {};               // ex -> {req, err, walls, cycleMs, lastCycle, backoff}
  let cfg;

  /* ---------- helpers ---------- */
  const now = () => Date.now();
  const fmtUsd = v => (SB.util && SB.util.fmtUsd) ? SB.util.fmtUsd(v) : (v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K');
  const fmtAge = ms => { const s = ms / 1000; return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h' + (Math.floor(s / 60) % 60 ? Math.floor(s / 60) % 60 + 'm' : ''); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function parseUsd(s) {
    if (typeof s === 'number') return s;
    const m = String(s || '').trim().toUpperCase().match(/^([\d.]+)\s*([KMB])?$/);
    if (!m) return NaN;
    return parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1);
  }

  function coreExEnabled(id) {
    if (SB.enabledEx) return SB.enabledEx().includes(id);
    const e = SB.cfg.exchanges;
    if (Array.isArray(e)) return e.some(x => x === id || (x && x.id === id && x.on));
    return true;
  }
  const scanEnabled = id => !!SB.ex && !!SB.ex[id] && coreExEnabled(id) && cfg.exchanges[id] !== false;

  function isRound(p) {
    if (!(p > 0)) return false;
    const step = Math.pow(10, Math.floor(Math.log10(p)) - 1) / 2;
    const r = p / step;
    return Math.abs(r - Math.round(r)) < 1e-6 * Math.max(1, r);
  }

  function brp(coin, ex) {
    const o = cfg.override && cfg.override[coin.key];
    if (o > 0) return o;
    if (cfg.mode === 'manual') return cfg.manual;
    let vol = coin.vol24 || 0;
    for (const id in coin.src || {}) vol = Math.max(vol, coin.src[id].vol24 || 0);
    return Math.max(cfg.autoMin, vol / 1440 * cfg.autoMinutes);
  }

  function sizeCat(size, base) {
    const m = cfg.mult;
    return size >= base * m[2] ? 2 : size >= base * m[1] ? 1 : size >= base * m[0] ? 0 : -1;
  }

  // effective category of a wall right now (size category, minus one if younger than minLife)
  function catOf(w, t) {
    const young = (t || now()) - w.first < cfg.minLife * 1000;
    return { cat: Math.max(0, w.sc - (young ? 1 : 0)), young };
  }

  function refPrice(coin, ex) {
    if (ex === coin.ex && coin.price > 0) return coin.price;
    const s = coin.src && coin.src[ex];
    return (s && s.price) || coin.price;
  }

  /* ---------- scanning ---------- */
  function processBook(coin, ex, book, t) {
    const s = coin.src[ex] || {};
    const tick = s.tick || coin.tick || 0;
    const bids = book.bids || [], asks = book.asks || [];
    if (!bids.length || !asks.length) return;
    const mid = (bids[0][0] + asks[0][0]) / 2;
    const base = brp(coin, ex);
    const bk = coin.key + '|' + ex;
    const prev = books.get(bk);
    const seen = new Set();
    const lo = bids[bids.length - 1][0], hi = asks[asks.length - 1][0];
    const tol = tick > 0 ? tick * 1.01 : mid * 1e-6;

    for (const [side, levels] of [['bid', bids], ['ask', asks]]) {
      for (const [p, q] of levels) {
        if (Math.abs(p - mid) / mid * 100 > MAXDEPTH) break;
        const size = p * q;
        const sc = sizeCat(size, base);
        if (sc < 0) continue;
        // match an existing wall at the same level (+- 1 tick)
        let w = null;
        if (prev) for (const id of prev.ids) {
          const o = walls.get(id);
          if (o && o.side === side && !seen.has(id) && Math.abs(o.price - p) <= tol) { w = o; break; }
        }
        if (w) {
          w.price = p; w.size = size; w.sc = sc; w.last = t;
          if (size > w.max) w.max = size;
        } else {
          const id = bk + '|' + side + '|' + p;
          w = walls.get(id);
          if (!w) {
            w = { id, key: coin.key, base: coin.base, ex, side, price: p, size, max: size, sc, first: t, last: t };
            walls.set(id, w);
          } else { w.size = size; w.sc = sc; w.last = t; }
        }
        w.brp = base; w.round = isRound(w.price);
        seen.add(w.id);
      }
    }
    // walls from the previous scan not seen now: gone if their price is inside what this book covered
    if (prev) for (const id of prev.ids) {
      if (seen.has(id)) continue;
      const o = walls.get(id);
      if (!o) continue;
      if (o.price >= lo && o.price <= hi) walls.delete(id);
      else seen.add(id);         // outside the returned levels: unknown, keep until STALE_MS
    }
    books.set(bk, { t, ids: seen, lo, hi });
  }

  function visibleKeys() {
    const set = new Set();
    if (SB.charts) for (const ctx of SB.charts) if (ctx && ctx.key) set.add(ctx.key);
    return set;
  }

  function pickJob(ex, fastSlot) {
    const list = SB.list || [];
    const t = now();
    const vis = visibleKeys();
    let fast = null, fastT = Infinity, rot = null, rotT = Infinity;
    for (const c of list) {
      if (!c.src || !c.src[ex]) continue;
      const b = books.get(c.key + '|' + ex);
      const lt = b ? b.t : 0;
      if (vis.has(c.key) && t - lt > cfg.fastSec * 1000 && lt < fastT) { fast = c; fastT = lt; }
      if (lt < rotT) { rot = c; rotT = lt; }
    }
    // also scan focus/board coins that are outside the filtered list
    for (const k of vis) {
      const c = SB.coin && SB.coin(k);
      if (!c || !c.src || !c.src[ex]) continue;
      const b = books.get(k + '|' + ex);
      const lt = b ? b.t : 0;
      if (t - lt > cfg.fastSec * 1000 && lt < fastT) { fast = c; fastT = lt; }
    }
    if (rot && t - rotT < 15e3) rot = null;   // whole list was refreshed within 15 s: nothing to rotate
    return fastSlot ? (fast || rot) : (rot || fast);
  }

  async function fetchDepth(ex, sym, limit) {
    const a = SB.ex[ex];
    // depth() of the core adapters already runs through adapter.limiter; the per-minute budget in
    // worker() keeps our share of the weight in bounds.
    return a.depth(sym, limit);
  }

  async function worker(ex) {
    const st = stats[ex] = { req: 0, err: 0, walls: 0, cycleMs: 0, cycleStart: now(), cycleSeen: new Set(), backoff: 0 };
    const b = BUDGET[ex] || { limit: 200, weight: 1, perMin: 300 };
    const interval = 60000 * b.weight / b.perMin;
    let slot = 0;
    for (;;) {
      const t0 = now();
      let job = null;
      if (cfg.enabled && scanEnabled(ex) && now() > st.backoff) job = pickJob(ex, (slot++ & 1) === 0);
      if (job) {
        const coin = job;
        try {
          const book = await fetchDepth(ex, coin.src[ex].sym, b.limit);
          st.req++;
          processBook(coin, ex, book, now());
          markDirty(coin.key);
          // cycle stats: time until every list coin on this exchange was scanned once
          st.cycleSeen.add(coin.key);
          const n = (SB.list || []).filter(c => c.src && c.src[ex]).length;
          if (n && st.cycleSeen.size >= n) { st.cycleMs = now() - st.cycleStart; st.cycleStart = now(); st.cycleSeen = new Set(); }
        } catch (e) {
          st.err++;
          const msg = String(e && e.message || e);
          if (/429|418|403|rate|too many/i.test(msg)) st.backoff = now() + 60e3;
          else st.backoff = now() + 2e3;
        }
      }
      const wait = job ? Math.max(0, interval - (now() - t0)) : 1000;
      await new Promise(r => setTimeout(r, wait));
    }
  }

  function purge() {
    const t = now();
    for (const [id, w] of walls) if (t - w.last > STALE_MS) walls.delete(id);
    for (const [bk, b] of books) if (t - b.t > STALE_MS * 2) books.delete(bk);
  }

  /* ---------- queries ---------- */
  // walls shown now: within cfg depth of the current price, correct side, coin in list or on a chart
  function current(opts) {
    opts = opts || {};
    const t = now();
    const keys = opts.key ? null : new Set((SB.list || []).map(c => c.key));
    if (keys) for (const k of visibleKeys()) keys.add(k);
    const out = [];
    for (const w of walls.values()) {
      if (opts.key && w.key !== opts.key) continue;
      if (keys && !keys.has(w.key)) continue;
      if (!scanEnabled(w.ex)) continue;
      const coin = SB.coin ? SB.coin(w.key) : SB.coins.get(w.key);
      if (!coin) continue;
      const ref = refPrice(coin, w.ex);
      if (!(ref > 0)) continue;
      const dist = (w.price - ref) / ref * 100;
      if (w.side === 'ask' ? dist < 0 : dist > 0) continue;   // price went through: eaten
      if (Math.abs(dist) > cfg.depth) continue;
      const c = catOf(w, t);
      out.push({ w, dist: Math.abs(dist), cat: c.cat, young: c.young, age: t - w.first });
    }
    return out;
  }

  /* ---------- update fan-out ---------- */
  const dirtyKeys = new Set();
  let dirtyAll = false, flushT = null;
  function markDirty(key) {
    if (key) dirtyKeys.add(key); else dirtyAll = true;
    if (!flushT) flushT = setTimeout(flush, 500);
  }
  function flush() {
    flushT = null;
    const keys = new Set(dirtyKeys), all = dirtyAll;
    dirtyKeys.clear(); dirtyAll = false;
    if (SB.charts) for (const ctx of SB.charts) if (all || keys.has(ctx.key)) syncChart(ctx);
    renderMap();
    SB.emit('density', { keys: [...keys], all });
  }

  /* ---------- density map panel ---------- */
  // Three columns by category (LARGE | MEDIUM | SMALL), asks in the top half, bids in the bottom half,
  // the label row in the middle is the current price. Vertical offset from the middle = distance from
  // price, linear up to cfg.depth. Plates that cannot be placed within MAXSHIFT of their true position
  // are dropped, smallest first, so the scale never lies.
  let mapEl, mapBody, mapInfo, lastLayout = '';
  const COLS = [2, 1, 0];                    // column order: category index
  const COL_NAMES = ['LARGE', 'MEDIUM', 'SMALL'];
  const PH = 15, PG = 2;                     // plate height, min vertical gap
  const LR = 18;                             // middle label row height
  const MAXSHIFT = 2.5 * (PH + PG);          // max nudge away from the true position

  function buildPanel() {
    mapEl = document.createElement('div');
    mapEl.className = 'dm';
    mapEl.innerHTML = '<div class="dm-head"><span class="dm-depth"></span><span class="dm-info"></span></div><div class="dm-body"></div>';
    mapBody = mapEl.querySelector('.dm-body');
    mapInfo = mapEl.querySelector('.dm-info');

    mapBody.addEventListener('click', e => {
      const p = e.target.closest('.dm-plate');
      if (p && SB.ui.openFocus) SB.ui.openFocus(p.dataset.key, p.dataset.ex);
    });
    mapBody.addEventListener('contextmenu', e => {
      const p = e.target.closest('.dm-plate');
      if (!p) return;
      e.preventDefault();
      if (SB.ui.openTerminal) SB.ui.openTerminal(p.dataset.key, p.dataset.ex, { exact: e.ctrlKey });
    });
    mapBody.addEventListener('mousedown', e => { if (e.button === 1 && e.target.closest('.dm-plate')) e.preventDefault(); });
    mapBody.addEventListener('auxclick', e => {
      const p = e.target.closest('.dm-plate');
      if (!p || e.button !== 1) return;
      e.preventDefault();
      if (SB.ui.openTerminal) SB.ui.openTerminal(p.dataset.key, p.dataset.ex, { exact: e.ctrlKey });
    });
    mapEl.addEventListener('wheel', e => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const d = e.deltaY || e.deltaX;
      if (!d) return;
      setDepth(cfg.depth + (d < 0 ? 0.5 : -0.5));
    }, { passive: false });

    if (SB.ui && SB.ui.addPanel) SB.ui.addPanel({ id: 'density', title: 'Density map', icon: '▤', el: mapEl, width: 380 });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
      if (mapBody.clientHeight + 'x' + mapBody.clientWidth !== lastLayout) renderMap();
    }).observe(mapBody);
  }

  function setDepth(v) {
    v = Math.max(1, Math.min(MAXDEPTH, Math.round(v * 2) / 2));
    if (v === cfg.depth) return;
    cfg.depth = v; SB.saveCfg();
    markDirty();
  }

  function scaleStep(depth) {
    for (const s of [0.5, 1, 2]) if (depth / s <= 6) return s;
    return 2;
  }

  // place plates of one (side, column): biggest first, each at the free spot nearest its true position
  function placeColumn(arr, lo, hi) {
    const placed = [];
    const free = y => placed.every(p => Math.abs(p.y - y) >= PH + PG - 0.01);
    arr.sort((a, b) => b.w.size / b.w.brp - a.w.size / a.w.brp);
    for (const it of arr) {
      const want = Math.max(lo, Math.min(hi - PH, it.want));
      const cands = [want];
      for (const p of placed) cands.push(p.y - PH - PG, p.y + PH + PG);
      let best = null, bestD = Infinity;
      for (const c of cands) {
        if (c < lo - 0.01 || c > hi - PH + 0.01) continue;
        const d = Math.abs(c - want);
        if (d < bestD && d <= MAXSHIFT && free(c)) { best = c; bestD = d; }
      }
      if (best !== null) { it.y = best; placed.push(it); }
    }
    return placed;
  }

  function renderMap() {
    if (!mapBody || !mapBody.isConnected || mapBody.offsetParent === null) return;
    const H = mapBody.clientHeight, W = mapBody.clientWidth;
    lastLayout = H + 'x' + W;
    mapEl.querySelector('.dm-depth').textContent = 'depth ' + cfg.depth + '%';
    if (H < 80 || W < 120) return;
    const aEnd = Math.round((H - LR) / 2), bStart = aEnd + LR;   // ask half [0, aEnd], bid half [bStart, H]
    const pad = 3, span = aEnd - 2 * pad - PH;
    const colW = W / 3;
    // top px of a plate (or tick line centre) at distance d% from price
    const yOf = (side, d) => side === 'ask'
      ? aEnd - pad - PH - Math.min(1, d / cfg.depth) * span
      : bStart + pad + Math.min(1, d / cfg.depth) * span;

    let html = '';
    for (let i = 0; i < 3; i++) {
      const l = (i * colW).toFixed(1), w = colW.toFixed(1);
      html += `<div class="dm-col dm-col-ask c${i}" style="left:${l}px;width:${w}px;top:0;height:${aEnd}px"></div>`
        + `<div class="dm-col dm-col-bid c${i}" style="left:${l}px;width:${w}px;top:${bStart}px;bottom:0"></div>`;
    }
    const step = scaleStep(cfg.depth);
    for (let d = step; d <= cfg.depth + 1e-9; d += step) {
      const lbl = (+d.toFixed(2)) + '%';
      for (const side of ['ask', 'bid']) {
        const y = Math.round(yOf(side, d) + PH / 2);
        html += `<div class="dm-tick" style="top:${y}px"></div><div class="dm-tlbl" style="top:${y}px;left:${(colW * 1.5).toFixed(1)}px">${lbl}</div>`;
      }
    }
    html += `<div class="dm-mid" style="top:${aEnd}px;height:${LR}px">`
      + COL_NAMES.map((n, i) => `<span style="left:${(i * colW).toFixed(1)}px;width:${colW.toFixed(1)}px">${n}</span>`).join('') + '</div>';

    const items = current();
    let shown = 0;
    for (const side of ['ask', 'bid']) {
      const lo = side === 'ask' ? 0 : bStart, hi = side === 'ask' ? aEnd : H;
      for (let ci = 0; ci < 3; ci++) {
        const cat = COLS[ci];
        const arr = items.filter(i => i.w.side === side && i.cat === cat)
          .sort((a, b) => b.w.size / b.w.brp - a.w.size / a.w.brp).slice(0, 80);
        for (const it of arr) it.want = yOf(side, it.dist);
        const placed = placeColumn(arr, lo, hi);
        const cx = ((ci + 0.5) * colW).toFixed(1), maxW = Math.floor(colW - 4);
        for (const it of placed) {
          const w = it.w;
          html += `<div class="dm-plate dm-${side} dm-${CATS[cat]}${it.young ? ' dm-young' : ''}" data-key="${esc(w.key)}" data-ex="${esc(w.ex)}"`
            + ` style="top:${Math.round(it.y)}px;left:${cx}px;max-width:${maxW}px"`
            + ` title="${esc(`${w.ex} ${w.key} ${side} @ ${w.price} · ${fmtUsd(w.size)} · ${it.dist.toFixed(2)}% · ${fmtAge(it.age)}${it.young ? ' (young)' : ''}`)}">`
            + `<span class="dm-ex">${esc(w.ex)}</span><b>${esc(w.base)}</b><span class="dm-sz">${fmtUsd(w.size)}</span>${w.round ? '<i class="dm-dot"></i>' : ''}</div>`;
          shown++;
        }
      }
    }
    mapBody.innerHTML = html;
    const tot = items.length;
    mapInfo.textContent = tot > shown ? `${shown} of ${tot}` : String(tot);
  }

  /* ---------- density lines on charts ---------- */
  // One series primitive per chart draws every wall of the coin: a line from the bar where the wall was
  // first seen to the right edge of the pane, plus a bordered "EX SIZE PRICE" box at the right end
  // (above the line for asks, below for bids; boxes of one side are nudged apart).
  const chartState = new WeakMap();   // ctx -> {prim, sig}
  let monoFont = '';
  function mono() {
    if (!monoFont) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
      monoFont = v || '"JetBrains Mono", ui-monospace, Menlo, monospace';
    }
    return monoFont;
  }
  function sideRGB(side) { return side === 'bid' ? '67,199,67' : '210,75,75'; }

  class DensityPrimitive {
    constructor() {
      this.items = [];
      this._req = null;
      const self = this;
      this._views = [{ zOrder: () => 'top', renderer: () => ({ draw: t => self._draw(t) }) }];
    }
    attached(p) { this._chart = p.chart; this._series = p.series; this._req = p.requestUpdate; }
    detached() { this._req = null; this._chart = this._series = null; }
    updateAllViews() {}
    paneViews() { return this._views; }
    autoscaleInfo() { return null; }
    set(items) { this.items = items; if (this._req) this._req(); }

    _draw(target) {
      if (!this.items.length || !this._series) return;
      const series = this._series, ts = this._chart.timeScale();
      target.useBitmapCoordinateSpace(sc => {
        const c = sc.context, hr = sc.horizontalPixelRatio, vr = sc.verticalPixelRatio;
        const Wm = sc.mediaSize.width, Hm = sc.mediaSize.height;
        const fs = 11, bh = 16;
        c.save();
        c.font = `${Math.round(fs * vr)}px ${mono()}`;
        c.textBaseline = 'middle';
        const rows = [];
        for (const it of this.items) {
          const y = series.priceToCoordinate(it.price);
          if (y == null || y < -bh || y > Hm + bh) continue;
          let x = ts.timeToCoordinate(it.t1);
          if (x == null) x = 0;
          x = Math.max(0, Math.min(Wm, x));
          const tw = c.measureText(it.label).width / hr;
          rows.push({ it, y, x, bw: Math.ceil(tw) + 10 });
        }
        // lines
        for (const r of rows) {
          const { it } = r;
          const lw = Math.max(1, Math.round(it.width * vr));
          const yb = Math.round(r.y * vr) + (lw % 2 ? 0.5 : 0);
          c.strokeStyle = `rgba(${sideRGB(it.side)},${it.alpha})`;
          c.lineWidth = lw;
          c.setLineDash(it.young ? [3 * hr, 3 * hr] : []);
          c.beginPath(); c.moveTo(Math.round(r.x * hr), yb); c.lineTo(Math.round(Wm * hr), yb); c.stroke();
        }
        c.setLineDash([]);
        // label boxes: asks above their line, bids below; nudge apart within a side
        const asks = rows.filter(r => r.it.side === 'ask').sort((a, b) => b.y - a.y);
        const bids = rows.filter(r => r.it.side === 'bid').sort((a, b) => a.y - b.y);
        let lim = Infinity;
        for (const r of asks) { r.top = Math.min(r.y - 1 - bh, lim - bh - 1); lim = r.top; }
        lim = -Infinity;
        for (const r of bids) { r.top = Math.max(r.y + 1, lim + 1); lim = r.top + bh; }
        for (const r of rows) {
          const rgb = sideRGB(r.it.side);
          const x0 = Math.round((Wm - 3 - r.bw) * hr) + 0.5, y0 = Math.round(r.top * vr) + 0.5;
          const w = Math.round(r.bw * hr), h = Math.round(bh * vr);
          c.globalAlpha = r.it.young ? 0.7 : 1;
          c.fillStyle = 'rgba(13,13,13,0.88)';
          c.fillRect(x0, y0, w, h);
          c.strokeStyle = `rgb(${rgb})`;
          c.lineWidth = Math.max(1, Math.round(hr));
          c.strokeRect(x0, y0, w, h);
          c.fillStyle = r.it.side === 'bid' ? '#5fd35f' : '#e06363';
          c.fillText(r.it.label, x0 + 5 * hr, y0 + h / 2 + 0.5 * vr);
        }
        c.restore();
      });
    }
  }

  function tfSec(tf) {
    const m = /^(\d+)([smhd])$/.exec(tf || '1m');
    return m ? +m[1] * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : 60;
  }

  function primOf(ctx) {
    let st = chartState.get(ctx);
    if (st) return st;
    const prim = new DensityPrimitive();
    try { ctx.series.attachPrimitive(prim); } catch (e) { console.warn('density primitive', e); return null; }
    st = { prim, sig: '', series: ctx.series };
    chartState.set(ctx, st);
    return st;
  }

  function clearChart(ctx) {
    const st = chartState.get(ctx);
    if (st && st.sig !== '') { st.prim.set([]); st.sig = ''; }
  }

  function syncChart(ctx) {
    if (!ctx || !ctx.chart || !ctx.series || ctx.dead) return;
    const bars = ctx.candles || [];
    if (!cfg.showOnCharts || !bars.length) { clearChart(ctx); return; }
    const st = primOf(ctx);
    if (!st) return;
    const coin = SB.coin ? SB.coin(ctx.key) : SB.coins.get(ctx.key);
    const step = tfSec(ctx.tf);
    const out = [];
    for (const it of current({ key: ctx.key })) {
      const w = it.w;
      // snap the first-seen time to a loaded bar (the primitive needs a time that exists in the series)
      const t0 = Math.floor(w.first / 1000 / step) * step;
      let i0 = 0;
      while (i0 < bars.length - 1 && bars[i0].t < t0) i0++;
      const s = coin && coin.src && coin.src[w.ex];
      const tick = (s && s.tick) || (coin && coin.tick) || 0;
      const price = SB.util && SB.util.fmtPrice ? SB.util.fmtPrice(w.price, tick) : String(w.price);
      out.push({
        id: w.id, side: w.side, price: w.price, t1: bars[i0].t, young: it.young,
        width: [1, 1.5, 2][it.cat], alpha: it.young ? 0.5 : [0.7, 0.9, 1][it.cat],
        label: `${w.ex} ${fmtUsd(w.size)} ${price}`,
      });
    }
    const sig = out.map(o => [o.id, o.t1, o.label, o.width, o.alpha].join('|')).join(';');
    if (sig === st.sig) return;
    st.sig = sig;
    st.prim.set(out);
  }

  function hookChart(ctx) {
    if (!ctx || ctx._dm) return;
    ctx._dm = true;
    if (ctx.onDestroy) ctx.onDestroy(() => dropChart(ctx));
    syncChart(ctx);
  }
  function dropChart(ctx) {
    ctx.dead = true;
    const st = chartState.get(ctx);
    if (st) { try { st.series.detachPrimitive(st.prim); } catch (e) { /* chart gone */ } }
    chartState.delete(ctx);
  }

  /* ---------- settings ---------- */
  function renderSettings(el) {
    const exs = SB.EX || Object.keys(BUDGET);  // core-disabled exchanges are shown greyed out
    const ov = Object.entries(cfg.override || {}).map(([k, v]) => k.replace(/USDT$/, '') + '=' + fmtUsd(v)).join(', ');
    el.innerHTML = `
      <div class="dm-set">
        <label><input type="checkbox" data-k="enabled"> Scan order books</label>
        <label><input type="checkbox" data-k="showOnCharts"> Show densities on charts</label>
        <h4>Base density size (BRP)</h4>
        <label><input type="radio" name="dm-mode" value="auto"> Auto: max(floor, coin's 24h volume on its biggest exchange / 1440 × minutes)</label>
        <div class="dm-row">minutes <input type="number" step="0.5" min="0.1" data-k="autoMinutes"> floor $ <input type="text" data-usd="autoMin"></div>
        <label><input type="radio" name="dm-mode" value="manual"> Manual, for all coins: $ <input type="text" data-usd="manual"></label>
        <div class="dm-row">Per coin (e.g. <code>BTC=50M, ETH=20M</code>):<br><input type="text" class="dm-ov" value="${esc(ov)}"></div>
        <h4>Categories</h4>
        <div class="dm-row">BRP × small <input type="number" step="0.1" min="0.1" data-m="0"> medium <input type="number" step="0.1" data-m="1"> large <input type="number" step="0.1" data-m="2"></div>
        <div class="dm-row">Min lifetime <input type="number" min="0" step="5" data-k="minLife"> s (younger walls shown one category lower)</div>
        <div class="dm-row">Depth <input type="number" min="1" max="10" step="0.5" data-k="depth"> % (Shift+wheel on the map)</div>
        <div class="dm-row">Re-scan visible coins every <input type="number" min="5" step="1" data-k="fastSec"> s</div>
        <h4>Exchanges to scan</h4>
        <div class="dm-row">${exs.map(id => `<label class="dm-ex"><input type="checkbox" data-ex="${id}"> ${id}</label>`).join('')}</div>
        <div class="dm-stats"></div>
      </div>`;
    const q = s => el.querySelectorAll(s);
    q('[data-k]').forEach(i => {
      const k = i.dataset.k;
      if (i.type === 'checkbox') i.checked = !!cfg[k]; else i.value = cfg[k];
      i.addEventListener('change', () => {
        let v = i.type === 'checkbox' ? i.checked : parseFloat(i.value);
        if (i.type !== 'checkbox' && !isFinite(v)) return;
        if (k === 'depth') return setDepth(v);
        cfg[k] = v; save();
      });
    });
    q('[data-usd]').forEach(i => {
      const k = i.dataset.usd;
      i.value = fmtUsd(cfg[k]);
      i.addEventListener('change', () => { const v = parseUsd(i.value); if (v > 0) { cfg[k] = v; save(); } i.value = fmtUsd(cfg[k]); });
    });
    q('[name="dm-mode"]').forEach(i => {
      i.checked = cfg.mode === i.value;
      i.addEventListener('change', () => { if (i.checked) { cfg.mode = i.value; save(); } });
    });
    q('[data-m]').forEach(i => {
      const n = +i.dataset.m;
      i.value = cfg.mult[n];
      i.addEventListener('change', () => { const v = parseFloat(i.value); if (v > 0) { cfg.mult[n] = v; cfg.mult.sort((a, b) => a - b); save(); } });
    });
    q('[data-ex]').forEach(i => {
      const id = i.dataset.ex;
      i.checked = cfg.exchanges[id] !== false;
      i.disabled = !coreExEnabled(id);
      i.addEventListener('change', () => { cfg.exchanges[id] = i.checked; save(); });
    });
    const ovIn = el.querySelector('.dm-ov');
    ovIn.addEventListener('change', () => {
      const o = {};
      for (const part of ovIn.value.split(/[,;\n]+/)) {
        const m = part.trim().match(/^([A-Za-z0-9]+)\s*[=:]\s*(\S+)$/);
        if (!m) continue;
        const v = parseUsd(m[2]);
        if (v > 0) o[m[1].toUpperCase().replace(/USDT$/, '') + 'USDT'] = v;
      }
      cfg.override = o; save();
    });
    const sEl = el.querySelector('.dm-stats');
    const showStats = () => {
      if (!sEl.isConnected) return;
      sEl.textContent = Object.entries(stats).map(([ex, s]) => `${ex}: ${s.req} req, ${s.err} err${s.cycleMs ? ', full pass ' + Math.round(s.cycleMs / 1000) + 's' : ''}`).join(' · ') + ` · ${walls.size} walls tracked`;
      setTimeout(showStats, 2000);
    };
    showStats();
  }

  function save() { SB.saveCfg(); markDirty(); }

  /* ---------- init ---------- */
  SB.init(() => {
    SB.defaults('density', {
      enabled: true, showOnCharts: true,
      mode: 'auto', autoMinutes: 3, autoMin: 100000, manual: 300000, override: {},
      mult: [2, 3.5, 5], minLife: 60, depth: 2.5, fastSec: 15,
      exchanges: {},
    });
    cfg = SB.cfg.density;
    if (!Array.isArray(cfg.mult) || cfg.mult.length !== 3) cfg.mult = [2, 3.5, 5];
    if (!cfg.exchanges || typeof cfg.exchanges !== 'object') cfg.exchanges = {};
    if (!cfg.override || typeof cfg.override !== 'object') cfg.override = {};

    buildPanel();
    if (SB.ui && SB.ui.addSettings) SB.ui.addSettings({ id: 'density', title: 'Densities', render: renderSettings });

    SB.on('chart:create', hookChart);
    SB.on('chart:data', ctx => { hookChart(ctx); syncChart(ctx); });
    SB.on('chart:destroy', ctx => { if (ctx) dropChart(ctx); });
    SB.on('list', () => markDirty());
    SB.on('panel', p => { if (p && p.id === 'density' && p.open) setTimeout(renderMap, 0); });

    let started = false;
    const start = () => {
      if (started || !SB.ex) return;
      started = true;
      for (const id of (SB.EX || Object.keys(SB.ex))) if (SB.ex[id]) worker(id);
    };
    SB.on('universe', start);
    SB.on('list', start);
    // refresh ages / extend segments / redraw map even when nothing changed
    setInterval(() => { purge(); markDirty(); }, 10e3);
    // panel may have just become visible
    setInterval(() => { if (mapBody && mapBody.offsetParent !== null && !mapBody.childElementCount) renderMap(); }, 1000);

    SB.density = {
      walls, books, stats, current, brp, isRound, setDepth, syncChart,
      lines: ctx => { const st = chartState.get(ctx); return st ? st.prim.items.map(i => i.label) : []; },
      setOverride(key, usd) { if (usd > 0) cfg.override[key] = usd; else delete cfg.override[key]; save(); },
      summary() {
        const cur = current();
        const by = {};
        for (const i of cur) { const k = i.w.ex + ' ' + CATS[i.cat]; by[k] = (by[k] || 0) + 1; }
        return { tracked: walls.size, shown: cur.length, by, stats: Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, { req: s.req, err: s.err, cycleS: Math.round(s.cycleMs / 1000) }])) };
      },
    };
  });
})();
