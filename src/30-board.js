// Chart board, coin list, search, focus mode, colour groups, hotkeys, core settings tabs.
(function () {
  'use strict';
  const SB = window.SB;
  const U = SB.util;
  const $ = SB.$;
  const LWC = window.LightweightCharts;

  SB.defaults(null, {
    boardTf: '15m',
    grid: { screener: [3, 3], group: [3, 3], focus: 4 },
    focusTfs: ['1m', '5m', '15m', '1h'],
    resortSec: 2,
    showList: true,
    groups: {},
    chartBars: 300,
  });
  const TFS = ['1s', '5s', '15s', '1m', '5m', '15m', '1h', '4h', '1d', '1w'];
  const TF_LABEL = { '1d': 'D', '1w': 'W' };
  const SEC_TF = { '1s': 1, '5s': 5, '15s': 15 };
  const tfSec = tf => SEC_TF[tf] || SB.TFSEC[tf];
  const WEEK_OFF = 345600; // epoch was a Thursday; weeks start Monday 00:00 UTC
  const bucketOf = (t, tf) => tf === '1w' ? Math.floor((t - WEEK_OFF) / 604800) * 604800 + WEEK_OFF : Math.floor(t / tfSec(tf)) * tfSec(tf);
  const GRIDS = [[1, 1], [2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [7, 7]];

  const state = { mode: 'screener', group: 1, page: 0, focus: null, frozenUntil: 0, lastSlot: 0, activeCtx: null };
  SB.board = state;
  SB.charts = new Set();
  const byKey = new Map(); // key -> Set(ctx)

  // ---------------- time formatting (charts run in UTC seconds, display local) ----------------
  const pad = n => String(n).padStart(2, '0');
  const fmtTime = t => { const d = new Date(t * 1000); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const tickFmt = (t, type) => {
    const d = new Date(t * 1000);
    if (type <= 1) return String(d.getFullYear());
    if (type === 2) return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
    if (type === 4) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return d.getHours() === 0 && d.getMinutes() === 0 ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ---------------- chart ----------------
  let chartSeq = 0;
  function makeChart(cell, coin, ex, tf, mode) {
    ex = ex && coin.src[ex] ? ex : coin.ex;
    const src = coin.src[ex];
    cell.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ch-head';
    head.innerHTML = `<span class="ch-name"><span class="ch-ico">${U.esc(coin.base.replace(/^1000+/, '')[0] || '?')}</span><span class="ch-tick">${U.esc(coin.base)}</span><span class="ch-exn">${ex}</span></span>
      <span class="ch-price"></span><span class="ch-inds"></span><span class="ch-badges"></span><span class="ch-gmark" title="Colour group (1-5)"></span>`;
    const body = document.createElement('div');
    body.className = 'ch-body';
    const fbtn = document.createElement('div');
    fbtn.className = 'ch-focus'; fbtn.innerHTML = SB.icon('focus', 13); fbtn.title = 'Focus';
    cell.append(head, body);
    body.appendChild(fbtn);

    const tick = src.tick || coin.tick;
    const chart = LWC.createChart(body, {
      autoSize: true,
      layout: { background: { type: 'solid', color: '#141414' }, textColor: '#8a8a8a', fontSize: 10, fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: 0, vertLine: { color: '#555', width: 1, style: 3, labelBackgroundColor: '#2a2a2a' }, horzLine: { color: '#555', width: 1, style: 3, labelBackgroundColor: '#2a2a2a' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.16 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: !!SEC_TF[tf], rightOffset: 4, tickMarkFormatter: tickFmt },
      watermark: { visible: true, text: coin.base, color: 'rgba(255,255,255,0.055)', fontSize: 56, fontFamily: 'JetBrains Mono, monospace', fontStyle: '600' },
      localization: { timeFormatter: fmtTime, priceFormatter: p => U.fmtPrice(p, tick) },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#43c743', downColor: '#c74343', wickUpColor: '#43c743', wickDownColor: '#c74343', borderVisible: false,
      priceLineColor: '#9a9a9a', priceLineStyle: 3,
      priceFormat: { type: 'price', precision: Math.min(U.decimals(tick), 10), minMove: tick || 0.0001 },
    });
    const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    const ctx = {
      id: ++chartSeq, key: coin.key, ex, sym: src.sym, tf, el: cell, head, badges: head.querySelector('.ch-badges'),
      chart, series, volume, candles: [], mode, hover: null, markers: [], _destroy: [], _mv: new Map(),
      onDestroy(fn) { this._destroy.push(fn); },
      priceAt: y => series.coordinateToPrice(y), yAt: p => series.priceToCoordinate(p),
    };
    cell._ctx = ctx;
    SB.charts.add(ctx);
    if (!byKey.has(coin.key)) byKey.set(coin.key, new Set());
    byKey.get(coin.key).add(ctx);

    // header interactions
    head.querySelector('.ch-name').onclick = () => SB.ui.openFocus(coin.key, ex);
    // watermark scales with the card
    new ResizeObserver(() => {
      if (ctx.dead) return;
      const w = body.clientWidth, h = body.clientHeight;
      ctx.chart.applyOptions({ watermark: { fontSize: Math.round(Math.max(16, Math.min((w - 70) * 0.55 / (coin.base.length * 0.6), h / 4.5))) } });
    }).observe(body);
    head.querySelector('.ch-gmark').onclick = () => cycleGroup(coin);
    fbtn.onclick = () => SB.ui.openFocus(coin.key, ex);
    const termHandler = e => {
      if (e.button === 2 && e.shiftKey) { e.preventDefault(); SB.ui.openFocus(coin.key, ex); return; }
      if (SB.ui.isTermClick(e)) { e.preventDefault(); SB.ui.openTerminal(coin.key, ex, { exact: e.ctrlKey }); }
    };
    head.addEventListener('mousedown', termHandler);
    head.addEventListener('contextmenu', e => e.preventDefault());
    body.addEventListener('contextmenu', e => { e.preventDefault(); });
    body.addEventListener('mousedown', e => {
      if (e.button === 2) termHandler(e);
      if (e.button === 1) e.preventDefault(); // no autoscroll; middle button is the ruler (drawings)
    });
    cell.addEventListener('mouseenter', () => { SB.hoverCtx = ctx; state.activeCtx = ctx; });
    cell.addEventListener('mouseleave', () => { if (SB.hoverCtx === ctx) SB.hoverCtx = null; });

    chart.subscribeCrosshairMove(param => {
      if (param.point && param.time != null) {
        ctx.hover = { price: series.coordinateToPrice(param.point.y), time: param.time, x: param.point.x, y: param.point.y };
      } else ctx.hover = null;
      if (ctx.mode === 'focus' && !ctx._syncing) syncCrosshair(ctx, param);
    });

    // history backfill on scroll to the left edge
    chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (r && r.from < 10 && !ctx.loadingOld && ctx.candles.length && !ctx.noMoreHistory && !SEC_TF[tf]) loadOlder(ctx);
    });

    loadChart(ctx);
    SB.emit('chart:create', ctx);
    return ctx;
  }

  function destroyChart(ctx) {
    if (!ctx || ctx.dead) return;
    ctx.dead = true;
    SB.emit('chart:destroy', ctx);
    for (const fn of ctx._destroy) { try { fn(); } catch (e) { console.error(e); } }
    if (ctx.unTrades) ctx.unTrades();
    SB.charts.delete(ctx);
    const s = byKey.get(ctx.key); if (s) s.delete(ctx);
    try { ctx.chart.remove(); } catch (e) {}
    if (SB.hoverCtx === ctx) SB.hoverCtx = null;
    if (ctx.el) ctx.el._ctx = null;
  }

  const volBar = b => ({ time: b.t, value: b.v, color: 'rgba(140,140,140,.38)' });
  const bar = b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c });

  async function loadChart(ctx) {
    const coin = SB.coin(ctx.key);
    if (SEC_TF[ctx.tf]) {
      ctx.candles = [];
      subscribeTrades(ctx);
      SB.emit('chart:data', ctx);
      return;
    }
    try {
      const k = await SB.ex[ctx.ex].klines(ctx.sym, ctx.tf, SB.cfg.chartBars, null, { prio: ctx.mode === 'focus' ? 20 : 10 });
      if (ctx.dead) return;
      ctx.candles = k.map(x => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
      ctx.series.setData(ctx.candles.map(bar));
      ctx.volume.setData(ctx.candles.map(volBar));
      ctx.histEx = ctx.ex;
      // volume bookkeeping for live aggregation of higher TFs from 1m
      const last = ctx.candles[ctx.candles.length - 1];
      if (last && coin && coin.m1.length) {
        const cm = coin.m1[coin.m1.length - 1];
        ctx._baseV = last.v - (cm && cm.t >= last.t ? coin.m1.filter(m => m.t >= last.t).reduce((s, m) => s + m.v, 0) : 0);
      }
      ctx._mv = new Map();
      if (coin && coin.ex !== ctx.ex) subscribeTrades(ctx); // non-primary source: live from its trade stream
      SB.emit('chart:data', ctx);
    } catch (e) {
      console.warn('chart load', ctx.ex, ctx.sym, e.message);
      if (!ctx.dead) setTimeout(() => !ctx.dead && loadChart(ctx), 5000);
    }
  }

  async function loadOlder(ctx) {
    ctx.loadingOld = true;
    const coin = SB.coin(ctx.key);
    try {
      const first = ctx.candles[0];
      const order = [ctx.histEx, ...SB.enabledEx(), 'BI-F', 'BI-S', 'BY-F', 'BY-S', 'OK-F', 'OK-S']
        .filter((v, i, a) => a.indexOf(v) === i && coin && coin.src[v]);
      const start = order.indexOf(ctx.histEx);
      for (let i = start; i < order.length; i++) {
        const id = order[i];
        const k = await SB.ex[id].klines(coin.src[id].sym, ctx.tf, 500, first.t * 1000 - 1, { prio: 15 });
        if (ctx.dead) return;
        const older = k.filter(x => x.t < first.t).map(x => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
        if (!older.length) continue;
        if (id !== ctx.histEx) {
          // boundary marker between exchanges
          ctx.markers.push({ time: first.t, position: 'aboveBar', color: '#999999', shape: 'square', text: ctx.histEx });
          ctx.markers.sort((a, b) => a.time - b.time);
          ctx.series.setMarkers(ctx.markers);
          ctx.histEx = id;
        }
        ctx.candles = older.concat(ctx.candles);
        ctx.series.setData(ctx.candles.map(bar));
        ctx.volume.setData(ctx.candles.map(volBar));
        SB.emit('chart:data', ctx);
        ctx.loadingOld = false;
        return;
      }
      ctx.noMoreHistory = true;
    } catch (e) { console.warn('older', e.message); }
    ctx.loadingOld = false;
  }

  // live update from the coin's 1m feed (primary source)
  function onM1Chart(ctx, k) {
    if (ctx.dead || SEC_TF[ctx.tf] || ctx.ex !== SB.coin(ctx.key).ex || !ctx.candles.length) return;
    const sec = tfSec(ctx.tf);
    const b = bucketOf(k.t, ctx.tf);
    const c = ctx.candles;
    let last = c[c.length - 1];
    if (b > last.t) {
      last = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
      c.push(last);
      ctx._baseV = 0; ctx._mv = new Map([[k.t, k.v]]);
      if (c.length > 3000) {
        c.splice(0, c.length - 3000);
        ctx.series.setData(c.map(bar)); ctx.volume.setData(c.map(volBar)); SB.emit('chart:data', ctx);
        return;
      }
    } else if (b === last.t) {
      if (sec === 60) { last.o = k.o; last.h = k.h; last.l = k.l; last.v = k.v; }
      else {
        last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l);
        ctx._mv.set(k.t, k.v);
        let s = ctx._baseV || 0; for (const v of ctx._mv.values()) s += v;
        last.v = Math.max(last.v, s);
      }
      last.c = k.c;
    } else return;
    ctx.series.update(bar(last));
    ctx.volume.update(volBar(last));
  }

  // trade-driven bars: seconds TFs, and charts opened on a non-primary exchange
  function subscribeTrades(ctx) {
    if (ctx.unTrades) return;
    const sec = tfSec(ctx.tf);
    let pending = false;
    const flush = () => {
      pending = false;
      if (ctx.dead) return;
      const last = ctx.candles[ctx.candles.length - 1];
      if (!last) return;
      if (ctx._needSet) { ctx._needSet = false; ctx.series.setData(ctx.candles.map(bar)); ctx.volume.setData(ctx.candles.map(volBar)); SB.emit('chart:data', ctx); }
      else { ctx.series.update(bar(last)); ctx.volume.update(volBar(last)); }
    };
    ctx.unTrades = SB.ex[ctx.ex].trades(ctx.sym, tr => {
      if (ctx.dead) return;
      const b = bucketOf(Math.floor(tr.t / 1000), ctx.tf);
      const c = ctx.candles;
      let last = c[c.length - 1];
      if (!last) { c.push({ t: b, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: tr.p * tr.q }); ctx._needSet = true; }
      else if (b > last.t) {
        // fill empty seconds so the chart keeps a continuous axis
        if (SEC_TF[ctx.tf]) for (let t = last.t + sec; t < b && b - t < 600; t += sec) c.push({ t, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 });
        c.push({ t: b, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: tr.p * tr.q });
        if (c.length > 5000) { c.splice(0, c.length - 5000); ctx._needSet = true; }
        if (b - last.t > sec) ctx._needSet = true;
      } else if (b === last.t) {
        last.h = Math.max(last.h, tr.p); last.l = Math.min(last.l, tr.p); last.c = tr.p; last.v += tr.p * tr.q;
      } else return;
      if (!pending) { pending = true; requestAnimationFrame(flush); }
    });
  }

  SB.on('m1', ({ coin, candle }) => {
    const s = byKey.get(coin.key);
    if (s) for (const ctx of s) onM1Chart(ctx, candle);
  });

  // focus mode crosshair sync
  function syncCrosshair(src, param) {
    for (const ctx of SB.charts) {
      if (ctx === src || ctx.mode !== 'focus' || ctx.dead) continue;
      ctx._syncing = true;
      try {
        if (!param.point || param.time == null) ctx.chart.clearCrosshairPosition();
        else {
          const price = src.series.coordinateToPrice(param.point.y);
          const t = bucketOf(param.time, ctx.tf);
          if (price != null && ctx.candles.length) ctx.chart.setCrosshairPosition(price, Math.max(t, ctx.candles[0].t), ctx.series);
        }
      } catch (e) {}
      ctx._syncing = false;
    }
  }

  // ---------------- board ----------------
  const boardEl = () => $('#board');
  let cells = [];

  function gridDims() {
    if (state.mode === 'focus') {
      const n = SB.cfg.grid.focus;
      return n === 1 ? [1, 1] : n === 2 ? [2, 1] : [2, 2];
    }
    return state.mode === 'group' ? SB.cfg.grid.group : SB.cfg.grid.screener;
  }
  function sourceList() {
    if (state.mode === 'group') return SB.list.concat([...SB.coins.values()].filter(c => c.group === state.group && !SB.passesVol(c)))
      .filter(c => c.group === state.group);
    return SB.list;
  }
  function pageCount() { const [c, r] = gridDims(); return Math.max(1, Math.ceil(sourceList().length / (c * r))); }

  function layout() {
    const [c, r] = gridDims();
    const b = boardEl();
    b.style.gridTemplateColumns = `repeat(${c}, minmax(0, 1fr))`;
    b.style.gridTemplateRows = `repeat(${r}, minmax(0, 1fr))`;
    const n = c * r;
    while (cells.length > n) { const el = cells.pop(); destroyChart(el._ctx); el.remove(); }
    while (cells.length < n) { const el = document.createElement('div'); el.className = 'cell'; b.appendChild(el); cells.push(el); }
  }

  // which coins/tfs each slot should show
  function wanted() {
    const [c, r] = gridDims();
    const n = c * r;
    if (state.mode === 'focus') {
      const f = state.focus;
      return Array.from({ length: n }, (_, i) => ({ key: f.key, ex: f.ex, tf: SB.cfg.focusTfs[i] || '5m' }));
    }
    const list = sourceList();
    state.page = Math.min(state.page, pageCount() - 1);
    return list.slice(state.page * n, state.page * n + n).map(x => ({ key: x.key, ex: x.ex, tf: SB.cfg.boardTf }));
  }

  function renderBoard(force) {
    if (!SB.coins.size) return;
    layout();
    const want = wanted();
    const mode = state.mode === 'focus' ? 'focus' : 'board';
    cells.forEach((cell, i) => {
      const w = want[i];
      const ctx = cell._ctx;
      if (!w) {
        if (ctx) destroyChart(ctx);
        if (!cell.querySelector('.ch-empty')) cell.innerHTML = '<div class="ch-empty">—</div>';
        return;
      }
      if (ctx && !force && ctx.key === w.key && ctx.tf === w.tf && ctx.ex === (w.ex || ctx.ex) && ctx.mode === mode) return;
      if (ctx) destroyChart(ctx);
      const coin = SB.coin(w.key);
      if (coin) makeChart(cell, coin, w.ex, w.tf, mode);
    });
    state.lastSlot = Date.now();
    renderHeads();
    renderToolbar();
  }
  SB.renderBoard = renderBoard;

  function renderHeads() {
    for (const ctx of SB.charts) {
      const coin = SB.coin(ctx.key);
      if (!coin) continue;
      const src = coin.src[ctx.ex] || {};
      const price = ctx.candles.length ? ctx.candles[ctx.candles.length - 1].c : src.price;
      const h = ctx.head;
      h.querySelector('.ch-price').textContent = U.fmtPrice(price, src.tick);
      h.querySelector('.ch-gmark').className = 'ch-gmark' + (coin.group ? ' g' + coin.group : '');
      h.querySelector('.ch-inds').innerHTML = SB.cfg.chartInds.map(d => {
        const v = coin.ind[SB.indId(d)];
        return `<span class="chip ${SB.indClass(d, v)}" title="${SB.indLabel(d)}"><i>${SB.IND_ICON[d.type] || ''}</i>${SB.fmtInd(d, v)}</span>`;
      }).join('');
      ctx.el.classList.toggle('hl', ctx === state.activeCtx && state.mode === 'focus');
    }
  }

  // list updates: resort the board unless frozen
  SB.on('list', () => {
    const now = Date.now();
    if (state.mode !== 'focus' && now >= state.frozenUntil && now - state.lastSlot >= SB.cfg.resortSec * 1000) renderBoard();
    renderHeads();
    renderList();
    renderToolbar();
  });
  SB.on('universe', () => renderBoard());

  // ---------------- colour groups ----------------
  function setGroup(coin, g) {
    coin.group = coin.group === g ? null : g;
    if (coin.group) SB.cfg.groups[coin.key] = coin.group; else delete SB.cfg.groups[coin.key];
    SB.saveCfg();
    if (SB.syncFeeds) SB.syncFeeds();
    SB.emit('group', coin);
    renderHeads();
  }
  function cycleGroup(coin) { // none -> 1 -> 2 ... -> 5 -> none
    const g = coin.group;
    if (g === 5) setGroup(coin, 5); else setGroup(coin, (g || 0) + 1);
  }
  SB.setGroup = setGroup;

  // ---------------- modes ----------------
  SB.ui.openFocus = (key, ex) => {
    const coin = SB.coin(key);
    if (!coin) return;
    if (state.mode !== 'focus') state.prevMode = state.mode;
    state.mode = 'focus';
    state.focus = { key, ex: ex && coin.src[ex] ? ex : coin.ex };
    closeSearch();
    renderBoard(true);
    SB.emit('focus', state.focus);
  };
  SB.ui.exitFocus = () => {
    if (state.mode !== 'focus') return;
    state.mode = state.prevMode || 'screener';
    renderBoard(true);
  };
  function setMode(mode, group) {
    state.mode = mode;
    if (group) state.group = group;
    state.page = 0;
    renderBoard(true);
  }
  function page(d) {
    if (state.mode === 'focus') return;
    const n = pageCount();
    state.page = (state.page + d + n) % n;
    renderBoard();
  }

  // ---------------- toolbar ----------------
  function renderToolbar() {
    const m = $('#tb-mode');
    if (!m._built) {
      m._built = true;
      m.innerHTML = `<button class="tb-btn" data-m="screener" title="All coins (screener)">All</button>` +
        [1, 2, 3, 4, 5].map(g => `<button class="gbtn g${g}" data-g="${g}" title="Group ${g} (key ${g})"></button>`).join('') +
        `<button class="tb-btn" data-m="focus" id="tb-focus" title="Focus (Esc to exit)"></button>`;
      m.onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.g) setMode('group', +b.dataset.g);
        else if (b.dataset.m === 'screener') setMode('screener');
        else if (b.dataset.m === 'focus' && state.focus) SB.ui.openFocus(state.focus.key, state.focus.ex);
      };
    }
    m.querySelector('[data-m=screener]').classList.toggle('on', state.mode === 'screener');
    m.querySelectorAll('[data-g]').forEach(b => b.classList.toggle('on', state.mode === 'group' && +b.dataset.g === state.group));
    const fb = $('#tb-focus');
    fb.textContent = state.focus ? '◎ ' + SB.coin(state.focus.key)?.base : '';
    fb.classList.toggle('hidden', !state.focus);
    fb.classList.toggle('on', state.mode === 'focus');

    const s = $('#tb-sort');
    if (!s._built) {
      s._built = true;
      s.innerHTML = `<button class="tb-btn" id="sort-dir" title="Sort direction"></button><select class="tb-in" id="sort-sel" title="Sort by"></select>
        <button class="tb-btn" id="sort-abs" title="Sort by absolute value">|x|</button>`;
      $('#sort-sel').onchange = e => { SB.cfg.sort.id = e.target.value; SB.saveCfg(); state.lastSlot = 0; SB.recompute(); };
      $('#sort-dir').onclick = () => { SB.cfg.sort.dir *= -1; SB.saveCfg(); state.lastSlot = 0; SB.recompute(); };
      $('#sort-abs').onclick = () => { SB.cfg.sort.abs = !SB.cfg.sort.abs; SB.saveCfg(); state.lastSlot = 0; SB.recompute(); };
    }
    const sel = $('#sort-sel');
    const opts = SB.cfg.sortInds.map(d => [SB.indId(d), SB.indLabel(d)]);
    if (!opts.find(o => o[0] === SB.cfg.sort.id)) opts.unshift([SB.cfg.sort.id, SB.indLabel(SB.indParse(SB.cfg.sort.id))]);
    const sig = opts.map(o => o[0]).join();
    if (sel._sig !== sig) { sel._sig = sig; sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); }
    sel.value = SB.cfg.sort.id;
    $('#sort-dir').innerHTML = SB.icon(SB.cfg.sort.dir < 0 ? 'sortd' : 'sortu', 14);
    $('#sort-abs').classList.toggle('on', !!SB.cfg.sort.abs);

    const f = $('#tb-filter');
    if (!f._built) {
      f._built = true;
      f.innerHTML = `<span class="tb-label" title="Min 24h volume">${SB.icon('filter', 13)} ${SB.icon('vol', 13)}</span><input class="tb-in" id="vol-in" title="Min 24h volume, e.g. 10M">`;
      const vi = $('#vol-in');
      vi.value = '$' + U.fmtUsd(SB.cfg.volMin);
      vi.onchange = () => {
        const v = U.parseUsd(vi.value);
        if (v != null) { SB.cfg.volMin = v; SB.saveCfg(); state.lastSlot = 0; if (SB.syncFeeds) SB.syncFeeds(); SB.recompute(); }
        vi.value = '$' + U.fmtUsd(SB.cfg.volMin);
        vi.blur();
      };
    }

    const t = $('#tb-tf');
    if (!t._built) {
      t._built = true;
      t.innerHTML = TFS.map(x => `<button class="tb-btn" data-tf="${x}">${(TF_LABEL[x] || x).toUpperCase()}</button>`).join('');
      t.onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        const tf = b.dataset.tf;
        if (state.mode === 'focus') {
          const i = Math.max(0, [...SB.charts].filter(c => c.mode === 'focus').sort((a, b) => cells.indexOf(a.el) - cells.indexOf(b.el)).indexOf(state.activeCtx));
          SB.cfg.focusTfs[i] = tf;
        } else SB.cfg.boardTf = tf;
        SB.saveCfg();
        renderBoard();
      };
    }
    const curTf = state.mode === 'focus' ? (state.activeCtx && state.activeCtx.mode === 'focus' ? state.activeCtx.tf : SB.cfg.focusTfs[0]) : SB.cfg.boardTf;
    t.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tf === curTf));

    const g = $('#tb-grid');
    if (!g._built) {
      g._built = true;
      g.innerHTML = `<span class="tb-label" title="Grid">${SB.icon('grid', 13)}</span><select class="tb-in" id="grid-sel" title="Charts on the board"></select>`;
      $('#grid-sel').onchange = e => {
        const v = e.target.value;
        if (state.mode === 'focus') SB.cfg.grid.focus = +v;
        else SB.cfg.grid[state.mode] = v.split('x').map(Number);
        SB.saveCfg();
        renderBoard();
      };
    }
    const gs = $('#grid-sel');
    const gopts = state.mode === 'focus' ? [['1', '1'], ['2', '2'], ['4', '4']] : GRIDS.map(([c, r]) => [`${c}x${r}`, `${c}×${r}`]);
    const gsig = state.mode === 'focus' ? 'f' : 'b';
    if (gs._sig !== gsig) { gs._sig = gsig; gs.innerHTML = gopts.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); }
    gs.value = state.mode === 'focus' ? String(SB.cfg.grid.focus) : SB.cfg.grid[state.mode].join('x');

    const p = $('#tb-page');
    if (!p._built) {
      p._built = true;
      p.innerHTML = `<button class="tb-btn" id="pg-prev" title="Previous page (Shift+Space)">‹</button><span id="pg-n"></span><button class="tb-btn" id="pg-next" title="Next page (Space)">›</button><span id="frz" class="freeze"></span>`;
      $('#pg-prev').onclick = () => page(-1);
      $('#pg-next').onclick = () => page(1);
    }
    $('#pg-n').textContent = state.mode === 'focus' ? '' : `${state.page + 1}/${pageCount()}`;
    const left = Math.ceil((state.frozenUntil - Date.now()) / 1000);
    $('#frz').textContent = left > 0 && state.mode !== 'focus' ? ` ❄${left}` : '';

    const st = $('#tb-status');
    st.innerHTML = SB.enabledEx().map(id => {
      const f = SB.feeds && SB.feeds[id];
      const live = f ? f.conns.filter(c => c.alive).length : 0;
      const tot = f ? f.conns.length : 0;
      const ok = SB.status[id] === 'ok' && live === tot;
      const cls = SB.status[id] === 'err' ? 'bad' : ok ? 'ok' : 'wait';
      return `<span title="${id}: REST ${SB.status[id] || '…'}, WS ${live}/${tot}"><span class="dot ${cls}"></span>${id}</span>`;
    }).join('');
  }
  setInterval(() => { renderToolbar(); }, 1000);
  setInterval(renderHeads, 1000);

  // ---------------- coin list ----------------
  let listSig = '';
  function renderList() {
    const el = $('#list');
    $('#side').classList.toggle('nolist', !SB.cfg.showList);
    if (!SB.cfg.showList) return;
    const inds = SB.cfg.listInds;
    const visible = new Set([...SB.charts].map(c => c.key));
    const src = state.mode === 'group' ? sourceList() : SB.list;
    const head = `<div class="lopts">${SB.icon('list', 13)} Coins <span class="dim">(${src.length})</span><label title="Colour groups on top"><input type="checkbox" id="lmerge" ${SB.cfg.mergeGroups ? 'checked' : ''}> groups</label></div>
      <div class="lrow lhead" style="--n:${inds.length}"><span></span><span class="lt dim">TICKER</span>${inds.map(d =>
        `<span class="lv ${SB.cfg.sort.id === SB.indId(d) ? 'on' : ''}" data-sort="${SB.indId(d)}" title="${SB.indLabel(d)}">${SB.indHead(d)}</span>`).join('')}</div>`;
    const rows = src.map(c => `<div class="lrow ${visible.has(c.key) ? 'vis' : ''}" style="--n:${inds.length}" data-k="${c.key}" title="${c.key} ${c.ex}">
      <span class="lg ${c.group ? 'g' + c.group : ''}"></span><span class="lt">${U.esc(c.base)}</span>${inds.map(d => {
        const v = c.ind[SB.indId(d)]; return `<span class="lv ${SB.indClass(d, v)}">${SB.fmtInd(d, v)}</span>`;
      }).join('')}</div>`).join('');
    const html = head + rows;
    if (html === listSig) return;
    listSig = html;
    const st = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = st;
  }
  function bindList() {
    const el = $('#list');
    el.addEventListener('click', e => {
      if (e.target.id === 'lmerge') { SB.cfg.mergeGroups = e.target.checked; SB.saveCfg(); SB.recompute(); return; }
      const s = e.target.closest('[data-sort]');
      if (s) {
        if (SB.cfg.sort.id === s.dataset.sort) SB.cfg.sort.dir *= -1; else SB.cfg.sort.id = s.dataset.sort;
        SB.saveCfg(); state.lastSlot = 0; SB.recompute(); return;
      }
      const r = e.target.closest('[data-k]');
      if (r) SB.ui.openFocus(r.dataset.k);
    });
    el.addEventListener('mousedown', e => {
      const r = e.target.closest('[data-k]');
      if (r && SB.ui.isTermClick(e)) { e.preventDefault(); SB.ui.openTerminal(r.dataset.k, null, {}); }
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ---------------- search ----------------
  const RU = 'йцукенгшщзхъфывапролджэячсмитьбю', EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
  const toLatin = s => s.toLowerCase().split('').map(ch => { const i = RU.indexOf(ch); return i >= 0 ? EN[i] : ch; }).join('');
  const lev1 = (a, b) => { // edit distance <= 1
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, e = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++e > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return e + (a.length - i) + (b.length - j) <= 1;
  };
  let sel = 0, results = [];
  function openSearch(text = '') {
    const ov = $('#search'), inp = $('#search-input');
    ov.classList.remove('hidden');
    inp.value = text;
    inp.focus();
    runSearch();
  }
  function closeSearch() { $('#search').classList.add('hidden'); $('#search-input').blur(); }
  SB.ui.openSearch = openSearch;
  function runSearch() {
    const q = toLatin($('#search-input').value).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDTM?$|PERP$|SWAP$/, '');
    const all = [...SB.coins.values()];
    let r;
    if (!q) r = SB.list.slice(0, 30);
    else {
      const score = c => {
        const b = c.base;
        if (b === q) return 0;
        if (b.startsWith(q)) return 1 + b.length / 100;
        if (b.includes(q)) return 2 + b.length / 100;
        if (q.length >= 3 && lev1(b, q)) return 3;
        if (q.length >= 4 && lev1(b.slice(0, q.length), q)) return 4;
        return null;
      };
      r = all.map(c => [score(c), c]).filter(x => x[0] != null).sort((a, b) => a[0] - b[0] || (b[1].vol24 || 0) - (a[1].vol24 || 0)).slice(0, 30).map(x => x[1]);
    }
    results = r; sel = 0;
    $('#search-results').innerHTML = r.map((c, i) => `<div class="sr ${i === 0 ? 'sel' : ''}" data-k="${c.key}">
      <span class="st">${c.base}</span>${Object.keys(c.src).map(id => `<span class="ex ${id}" data-ex="${id}">${id}</span>`).join(' ')}
      <span class="sv">${U.fmtPrice(c.price, c.tick)} · ${U.fmtUsd(c.vol24)}</span></div>`).join('') || '<div class="sr dim">No coins</div>';
  }
  function bindSearch() {
    const inp = $('#search-input');
    inp.addEventListener('input', runSearch);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = Math.max(0, Math.min(results.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
        [...$('#search-results').children].forEach((d, i) => d.classList.toggle('sel', i === sel));
        $('#search-results').children[sel]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && results[sel]) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) { SB.ui.openTerminal(results[sel].key); closeSearch(); }
        else SB.ui.openFocus(results[sel].key);
      }
    });
    $('#search').addEventListener('mousedown', e => {
      if (e.target.id === 'search') { closeSearch(); return; }
      const r = e.target.closest('[data-k]');
      if (!r) return;
      const ex = e.target.dataset.ex;
      if (SB.ui.isTermClick(e)) { e.preventDefault(); SB.ui.openTerminal(r.dataset.k, ex, { exact: !!ex }); closeSearch(); return; }
      if (e.button === 0) SB.ui.openFocus(r.dataset.k, ex);
    });
    $('#search').addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('paste', e => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const text = (e.clipboardData || window.clipboardData).getData('text') || '';
      const q = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDTM?$|PERP$|SWAP$/, '').slice(0, 20);
      if (!q) return;
      e.preventDefault();
      openSearch(q);
      if (results.length && results[0].base === q) SB.ui.openFocus(results[0].key);
    });
  }

  // ---------------- hotkeys ----------------
  function bindKeys() {
    SB.hotkey('space', () => page(1));
    SB.hotkey('arrowdown', () => page(1));
    SB.hotkey('shift+space', () => page(-1));
    SB.hotkey('arrowup', () => page(-1));
    SB.hotkey('shift+r', () => { state.frozenUntil = 0; state.lastSlot = 0; SB.recompute(); renderBoard(); });
    for (const g of [1, 2, 3, 4, 5]) SB.hotkey(String(g), (e, ctx) => { if (ctx) setGroup(SB.coin(ctx.key), g); else setMode('group', g); });
    SB.hotkey('escape', () => {
      if (!$('#settings').classList.contains('hidden')) SB.ui.closeSettings();
      else if (state.mode === 'focus') SB.ui.exitFocus();
      else if (state.page > 0) { state.page = 0; renderBoard(); }
      else if (state.mode === 'group') setMode('screener');
    });
    SB.onUnhandledKey = (e, combo) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (/^[a-z0-9]$/.test(combo)) { e.preventDefault(); openSearch(combo.toUpperCase()); }
    };
    const b = boardEl();
    b.addEventListener('mousemove', () => { if (state.mode !== 'focus') state.frozenUntil = Date.now() + 3000; });
    b.addEventListener('wheel', e => { if (e.shiftKey && state.mode !== 'focus') { e.preventDefault(); e.stopPropagation(); page(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1); } }, { capture: true, passive: false });
  }

  // ---------------- settings tabs ----------------
  function reloadAll() { SB.reloadUniverse().then(() => { state.lastSlot = 0; renderBoard(true); }); }
  function settingsGeneral(box) {
    const F = SB.ui.field;
    F(box, 'Min 24h volume, USDT', { v: U.fmtUsd(SB.cfg.volMin) }, 'v', 'text', { onChange: v => { const n = U.parseUsd(v); if (n != null) { SB.cfg.volMin = n; SB.saveCfg(); $('#vol-in').value = '$' + U.fmtUsd(n); SB.syncFeeds && SB.syncFeeds(); SB.recompute(); } } });
    F(box, 'Resort board every, s', SB.cfg, 'resortSec', 'number');
    F(box, 'Bars per chart', SB.cfg, 'chartBars', 'number', { hint: 'max 1000' });
    F(box, 'Show coin list', SB.cfg, 'showList', 'checkbox', { onChange: () => { renderList(); window.dispatchEvent(new Event('resize')); } });
    F(box, 'Colour groups on top of list', SB.cfg, 'mergeGroups', 'checkbox', { onChange: () => SB.recompute() });
    const h = document.createElement('h4'); h.textContent = 'Focus timeframes (slot 1-4)'; box.appendChild(h);
    for (let i = 0; i < 4; i++) F(box, 'Slot ' + (i + 1), SB.cfg.focusTfs, i, 'select', { options: TFS, onChange: () => renderBoard() });
    const h2 = document.createElement('h4'); h2.textContent = 'Data'; box.appendChild(h2);
    const btn = document.createElement('button'); btn.className = 'sbtn'; btn.textContent = 'Reset all settings';
    btn.onclick = () => { if (confirm('Reset all Scalpview settings, groups and drawings?')) { localStorage.clear(); location.reload(); } };
    box.appendChild(btn);
  }
  function settingsExchanges(box) {
    const draw = () => {
      box.innerHTML = `<p class="dim">Order = priority. A coin listed on several exchanges is shown once, from the highest one.
        Volume filter for an exchange = base filter × coefficient.</p>`;
      const t = document.createElement('table'); t.className = 'stab';
      SB.cfg.exchanges.forEach((e, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><input type="checkbox" ${e.on ? 'checked' : ''}></td><td>${SB.ui.exTag(e.id)}</td><td>${SB.ex[e.id].name}</td>
          <td>coef <input type="number" step="0.1" value="${e.coef}" style="width:60px"></td>
          <td><button class="sbtn">↑</button> <button class="sbtn">↓</button></td>`;
        const [cb, coef] = tr.querySelectorAll('input');
        const [up, dn] = tr.querySelectorAll('button');
        cb.onchange = () => { e.on = cb.checked; SB.saveCfg(); reloadAll(); };
        coef.onchange = () => { e.coef = parseFloat(coef.value) || 1; SB.saveCfg(); SB.syncFeeds && SB.syncFeeds(); SB.recompute(); };
        const mv = d => { const a = SB.cfg.exchanges, j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; SB.saveCfg(); draw(); reloadAll(); };
        up.onclick = () => mv(-1); dn.onclick = () => mv(1);
        t.appendChild(tr);
      });
      box.appendChild(t);
    };
    draw();
  }
  function indEditor(box, title, arr, onChange) {
    const h = document.createElement('h4'); h.textContent = title; box.appendChild(h);
    const wrap = document.createElement('div'); box.appendChild(wrap);
    const draw = () => {
      wrap.innerHTML = '';
      arr.forEach((d, i) => {
        const r = document.createElement('div'); r.className = 'srow';
        r.innerHTML = `<select>${Object.entries(SB.IND_TYPES).map(([k, v]) => `<option value="${k}" ${k === d.type ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
          <select>${SB.IND_TFS.map(t => `<option ${t === d.tf ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <input type="number" min="1" max="200" value="${d.p}" style="width:60px">
          <button class="sbtn">↑</button><button class="sbtn">↓</button><button class="sbtn">✕</button>`;
        const [ty, tf] = r.querySelectorAll('select');
        const p = r.querySelector('input');
        const [up, dn, rm] = r.querySelectorAll('button');
        const ch = () => { SB.saveCfg(); onChange(); };
        ty.onchange = () => { d.type = ty.value; ch(); };
        tf.onchange = () => { d.tf = tf.value; ch(); };
        p.onchange = () => { d.p = Math.max(1, parseInt(p.value, 10) || 1); ch(); };
        up.onclick = () => { if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; ch(); draw(); } };
        dn.onclick = () => { if (i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; ch(); draw(); } };
        rm.onclick = () => { arr.splice(i, 1); ch(); draw(); };
        wrap.appendChild(r);
      });
      const add = document.createElement('button'); add.className = 'sbtn'; add.textContent = '+ add';
      add.onclick = () => { arr.push({ type: 'chg', tf: '5m', p: 1 }); SB.saveCfg(); onChange(); draw(); };
      wrap.appendChild(add);
    };
    draw();
  }
  function settingsIndicators(box) {
    box.innerHTML = `<p class="dim">Indicator = type, candle timeframe, period (number of candles). Computed live from 1m candles
      (up to ~5 h back); "1d / 1" uses the exchange 24h ticker, "today" = since 00:00 UTC. Trades are Binance only.</p>`;
    const ch = () => { SB.recompute(); renderHeads(); listSig = ''; renderList(); renderToolbar(); };
    indEditor(box, 'Above charts', SB.cfg.chartInds, ch);
    indEditor(box, 'Coin list columns', SB.cfg.listInds, ch);
    indEditor(box, 'Sort options', SB.cfg.sortInds, ch);
  }
  function settingsTerminals(box) {
    const t = SB.cfg.terminal;
    box.innerHTML = `<p class="dim">Right or middle click on a ticker (chart header, list, search, density map) opens it in your terminal.
      Ctrl+click opens the exact exchange you clicked instead of the priority one. URL placeholders: {SYM} {BASE} {EX} {EXNAME}.
      Vataga.terminal: enable "Application integration" in its settings and bind the order book window to the screener.</p>`;
    SB.ui.field(box, 'Terminal', t, 'kind', 'select', { options: [['vataga', 'Vataga.terminal'], ['metascalp', 'MetaScalp'], ['tiger', 'Tiger.com'], ['custom', 'Custom URL']] });
    SB.ui.field(box, 'Open with', t, 'button', 'select', { options: [['right', 'Right click'], ['middle', 'Middle click']] });
    for (const k of ['vataga', 'metascalp', 'tiger', 'custom']) SB.ui.field(box, k + ' URL', t.tmpl, k, 'text', { wide: true });
  }
  function settingsHotkeys(box) {
    const rows = [
      ['Any letter / digit', 'Coin search (works in any keyboard layout, typo tolerant)'], ['Ctrl+V', 'Search the ticker from the clipboard'],
      ['Esc', 'Exit focus / back to page 1 / close dialogs'], ['Space, ↓, Shift+wheel down', 'Next page'], ['Shift+Space, ↑', 'Previous page'],
      ['Shift+R', 'Resort the board now'], ['1-5 over a chart', 'Toggle colour group (without hover: open the group)'],
      ['Click ticker / ⤢', 'Focus mode'], ['Shift+Right click on chart', 'Focus mode'], ['Right/middle click', 'Open in terminal (Ctrl = exact exchange)'],
      ['Shift+A', 'Price alert'], ['Shift+S', 'Trend line'], ['Shift+D', 'Horizontal ray'], ['Ctrl (hold)', 'Magnet'], ['Middle drag / Shift+drag', 'Ruler'],
    ];
    box.innerHTML = '<table class="stab">' + rows.map(r => `<tr><td><b>${r[0]}</b></td><td class="dim">${r[1]}</td></tr>`).join('') + '</table>';
  }

  // ---------------- init ----------------
  SB.init(() => {
    SB.ui.addSettings({ id: 'general', title: 'General', render: settingsGeneral });
    SB.ui.addSettings({ id: 'exchanges', title: 'Exchanges', render: settingsExchanges });
    SB.ui.addSettings({ id: 'indicators', title: 'Indicators', render: settingsIndicators });
    SB.ui.addSettings({ id: 'terminals', title: 'Terminals', render: settingsTerminals });
    SB.ui.addSettings({ id: 'hotkeys', title: 'Hotkeys', render: settingsHotkeys });
    $('#btn-settings').onclick = () => SB.ui.openSettings();
    $('#btn-search').innerHTML = SB.icon('search', 14);
    $('#btn-settings').innerHTML = SB.icon('gear', 14) + ' Settings';
    $('#btn-full').innerHTML = SB.icon('full', 14);
    $('#btn-search').onclick = () => openSearch('');
    $('#btn-full').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    $('#settings-close').onclick = SB.ui.closeSettings;
    $('#settings').addEventListener('mousedown', e => { if (e.target.id === 'settings') SB.ui.closeSettings(); });
    SB.on('settings:closed', () => renderBoard(true));
    bindList(); bindSearch(); bindKeys();
    layout();
    renderToolbar();
    renderList();
  });
})();
