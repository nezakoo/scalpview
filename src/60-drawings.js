// Drawings: trend line, horizontal line, horizontal ray, rectangle, fib, pencil, ruler.
// Drawings belong to a coin key, are stored as {t (sec), p} points in localStorage 'sb.drawings'
// and render on every chart of that coin through one series primitive per chart ctx.
(function () {
  'use strict';
  const SB = window.SB;
  const LS_KEY = 'sb.drawings';
  const TOOLS = [
    ['trend', 'Trend line'], ['hline', 'Horizontal line'], ['hray', 'Horizontal ray'],
    ['rect', 'Rectangle'], ['fib', 'Fibonacci'], ['pencil', 'Pencil'],
  ];
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const TOL = 6;
  let cfg = null;

  // ---------- store ----------
  let store = {}; // key -> [ {id, type, pts:[{t,p}], color, width} ]
  const load = () => {
    try { store = (JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}).d || {}; } catch (e) { store = {}; }
  };
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      for (const k in store) if (!store[k].length) delete store[k];
      try { localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, d: store })); } catch (e) { console.error(e); }
    }, 150);
  };
  const list = key => store[key] || (store[key] = []);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- state ----------
  const views = new Map(); // ctx -> view {ctx, prim, req, bar, cleanup}
  let tool = null;     // active tool id
  let draft = null;    // {key, d, ctx, down:{x,y}, stage}
  let selected = null; // {key, id}
  let drag = null;     // {ctx, key, d, kind:'pt'|'body', idx, start:{lg,p}, orig}
  let ruler = null;    // {ctx, a:{t,p}, b:{t,p}}
  let suppressClick = false;

  const refresh = key => {
    for (const v of views.values()) if (key == null || v.ctx.key === key) v.req && v.req();
  };
  const selDrawing = () => selected && (store[selected.key] || []).find(d => d.id === selected.id);

  // ---------- coordinates ----------
  const UNIT = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const tfSec = ctx => {
    const m = /^(\d+)([smhdw])$/.exec(ctx.tf || '');
    if (m) return +m[1] * UNIT[m[2]];
    const c = ctx.candles;
    return c && c.length > 1 ? c[c.length - 1].t - c[c.length - 2].t || 60 : 60;
  };
  // time (sec) -> logical index (fractional, extrapolated outside the data)
  const t2l = (ctx, t) => {
    const c = ctx.candles;
    if (!c || !c.length) return null;
    const n = c.length, step = tfSec(ctx);
    if (t <= c[0].t) return (t - c[0].t) / step;
    if (t >= c[n - 1].t) return n - 1 + (t - c[n - 1].t) / step;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m].t <= t) lo = m; else hi = m; }
    return lo + (t - c[lo].t) / (c[hi].t - c[lo].t);
  };
  const l2t = (ctx, lg) => {
    const c = ctx.candles;
    if (!c || !c.length) return null;
    const n = c.length, step = tfSec(ctx);
    if (lg <= 0) return c[0].t + lg * step;
    if (lg >= n - 1) return c[n - 1].t + (lg - n + 1) * step;
    const i = Math.floor(lg);
    return c[i].t + (lg - i) * (c[i + 1].t - c[i].t);
  };
  const toXY = (ctx, pt) => {
    const lg = t2l(ctx, pt.t);
    if (lg == null) return null;
    const x = ctx.chart.timeScale().logicalToCoordinate(lg);
    const y = ctx.series.priceToCoordinate(pt.p);
    return x == null || y == null ? null : { x, y };
  };
  // pane-local mouse position for a ctx
  const paneRect = ctx => {
    const r = ctx.chart.chartElement().getBoundingClientRect();
    let lw = 0;
    try { lw = ctx.chart.priceScale('left').width() || 0; } catch (e) { /* no left scale */ }
    const s = ctx.chart.paneSize();
    return { left: r.left + lw, top: r.top, width: s.width, height: s.height };
  };
  const local = (ctx, e) => {
    const r = paneRect(ctx);
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, y, inside: x >= 0 && y >= 0 && x <= r.width && y <= r.height };
  };
  // pixel -> {t, p}; with magnet snaps to the nearest OHLC of the nearest candle
  const fromXY = (ctx, x, y, magnet) => {
    let lg = ctx.chart.timeScale().coordinateToLogical(x);
    let p = ctx.series.coordinateToPrice(y);
    if (lg == null || p == null) return null;
    const c = ctx.candles;
    if (magnet && c && c.length) {
      const i = Math.max(0, Math.min(c.length - 1, Math.round(lg)));
      const k = c[i];
      let best = k.c, bd = Infinity;
      for (const v of [k.o, k.h, k.l, k.c]) {
        const vy = ctx.series.priceToCoordinate(v);
        if (vy != null && Math.abs(vy - y) < bd) { bd = Math.abs(vy - y); best = v; }
      }
      lg = i; p = best;
    }
    return { t: l2t(ctx, lg), p };
  };

  // ---------- geometry / hit test ----------
  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let u = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    u = Math.max(0, Math.min(1, u));
    return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
  };
  const fibLevels = () => String(cfg.fibLevels).split(',').map(parseFloat).filter(isFinite);
  const fibPrice = (d, lv) => d.pts[1].p + (d.pts[0].p - d.pts[1].p) * lv;

  function hitDrawing(ctx, d, x, y, isSel) {
    const P = d.pts.map(pt => toXY(ctx, pt));
    if (P.some(q => !q)) return null;
    for (let i = 0; i < P.length && d.type !== 'pencil'; i++) {
      if (Math.hypot(P[i].x - x, P[i].y - y) <= TOL) return { kind: 'pt', idx: i };
    }
    const near = (ax, ay, bx, by) => segDist(x, y, ax, ay, bx, by) <= TOL;
    const [a, b] = P;
    switch (d.type) {
      case 'trend': return near(a.x, a.y, b.x, b.y) ? { kind: 'body' } : null;
      case 'hline': return Math.abs(y - a.y) <= TOL ? { kind: 'body' } : null;
      case 'hray': return x >= a.x - TOL && Math.abs(y - a.y) <= TOL ? { kind: 'body' } : null;
      case 'rect': {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        if (near(x0, y0, x1, y0) || near(x0, y1, x1, y1) || near(x0, y0, x0, y1) || near(x1, y0, x1, y1)) return { kind: 'body' };
        return isSel && x > x0 && x < x1 && y > y0 && y < y1 ? { kind: 'body' } : null;
      }
      case 'fib': {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        for (const lv of fibLevels()) {
          const ly = ctx.series.priceToCoordinate(fibPrice(d, lv));
          if (ly != null && near(x0, ly, x1, ly)) return { kind: 'body' };
        }
        return near(a.x, a.y, b.x, b.y) ? { kind: 'body' } : null;
      }
      case 'pencil':
        for (let i = 1; i < P.length; i++) if (near(P[i - 1].x, P[i - 1].y, P[i].x, P[i].y)) return { kind: 'body' };
        return null;
    }
    return null;
  }
  function findHit(ctx, x, y) {
    const arr = store[ctx.key] || [];
    const sel = selDrawing();
    if (sel && arr.includes(sel)) { const h = hitDrawing(ctx, sel, x, y, true); if (h) return Object.assign(h, { d: sel }); }
    for (let i = arr.length - 1; i >= 0; i--) {
      const h = hitDrawing(ctx, arr[i], x, y, false);
      if (h) return Object.assign(h, { d: arr[i] });
    }
    return null;
  }

  // ---------- rendering ----------
  const FONT = '10px "Noto Sans", system-ui, sans-serif';
  const alpha = (hex, a) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const tickOf = key => { const c = SB.coin && SB.coin(key); return c && c.tick; };
  const fmtP = (key, p) => SB.util.fmtPrice(p, tickOf(key));
  const fmtSpan = s => {
    s = Math.round(Math.abs(s));
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };
  function label(c, text, x, y, bg, fg, align) {
    c.font = FONT;
    const lines = text.split('\n');
    const w = Math.max(...lines.map(l => c.measureText(l).width)) + 8, h = lines.length * 13 + 4;
    const lx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    c.fillStyle = bg; c.fillRect(lx, y, w, h);
    c.fillStyle = fg; c.textBaseline = 'top';
    lines.forEach((l, i) => c.fillText(l, lx + 4, y + 3 + i * 13));
  }

  function drawOne(c, ctx, d, W, isSel) {
    const P = d.pts.map(pt => toXY(ctx, pt));
    if (P.some(q => !q)) return;
    const col = d.color || cfg['col' + cap(d.type)] || '#cccccc';
    c.strokeStyle = col; c.lineWidth = (d.width || cfg.width || 1) + (isSel ? 0.5 : 0);
    c.setLineDash([]); c.lineJoin = 'round'; c.lineCap = 'round';
    const line = (ax, ay, bx, by) => { c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); };
    const [a, b] = P;
    switch (d.type) {
      case 'trend': line(a.x, a.y, b.x, b.y); break;
      case 'hline': line(0, a.y, W, a.y); break;
      case 'hray': line(a.x, a.y, W, a.y); break;
      case 'rect':
        c.fillStyle = alpha(col, 0.12);
        c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        break;
      case 'fib': {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        c.setLineDash([3, 3]); c.globalAlpha = 0.5; line(a.x, a.y, b.x, b.y); c.globalAlpha = 1; c.setLineDash([]);
        c.font = FONT; c.textBaseline = 'bottom';
        let lastY = -1e9;
        for (const lv of fibLevels().sort((m, n) => fibPrice(d, n) - fibPrice(d, m))) {
          const p = fibPrice(d, lv), y = ctx.series.priceToCoordinate(p);
          if (y == null) continue;
          line(x0, y, x1, y);
          if (y - lastY < 11) continue; // skip labels that would overlap
          lastY = y;
          c.fillStyle = col;
          c.fillText(`${lv} (${fmtP(ctx.key, p)})`, Math.max(x0, 0) + 2, y - 1);
        }
        break;
      }
      case 'pencil':
        c.beginPath(); c.moveTo(a.x, a.y);
        for (let i = 1; i < P.length; i++) c.lineTo(P[i].x, P[i].y);
        c.stroke(); break;
    }
    if (isSel) {
      const hs = d.type === 'pencil' ? [P[0], P[P.length - 1]] : P;
      for (const q of hs) {
        let hx = q.x;
        if (d.type === 'hline') hx = Math.max(8, Math.min(W - 8, hx));
        c.beginPath(); c.arc(hx, q.y, 4, 0, Math.PI * 2);
        c.fillStyle = '#0d0d0d'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = col; c.stroke();
      }
    }
  }

  function drawRuler(c, ctx) {
    const A = toXY(ctx, ruler.a), B = toXY(ctx, ruler.b);
    if (!A || !B) return;
    const up = ruler.b.p >= ruler.a.p;
    const col = up ? '#43c743' : '#c74343';
    c.fillStyle = alpha(col, 0.15);
    c.fillRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
    c.strokeStyle = col; c.lineWidth = 1; c.setLineDash([]);
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    c.beginPath(); c.moveTo(mx, A.y); c.lineTo(mx, B.y); c.moveTo(A.x, my); c.lineTo(B.x, my); c.stroke();
    // arrow heads
    const ah = (x, y, dx, dy) => { c.beginPath(); c.moveTo(x, y); c.lineTo(x - dx * 5 - dy * 4, y - dy * 5 - dx * 4); c.moveTo(x, y); c.lineTo(x - dx * 5 + dy * 4, y - dy * 5 + dx * 4); c.stroke(); };
    if (Math.abs(B.y - A.y) > 12) ah(mx, B.y, 0, Math.sign(B.y - A.y));
    if (Math.abs(B.x - A.x) > 12) ah(B.x, my, Math.sign(B.x - A.x), 0);
    const dp = ruler.b.p - ruler.a.p, pct = ruler.a.p ? dp / ruler.a.p * 100 : 0;
    const bars = Math.round(Math.abs(t2l(ctx, ruler.b.t) - t2l(ctx, ruler.a.t)));
    const txt = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  ${dp >= 0 ? '+' : '−'}${fmtP(ctx.key, Math.abs(dp))}\n${bars} bars, ${fmtSpan(ruler.b.t - ruler.a.t)}`;
    const ly = B.y >= A.y ? Math.max(A.y, B.y) + 6 : Math.min(A.y, B.y) - 36;
    label(c, txt, mx, ly, alpha(col, 0.9), '#f2f2f2', 'center');
  }

  function makeView(ctx) {
    const v = { ctx, req: null, axis: [] };
    const renderer = {
      draw(target) {
        target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
          const W = mediaSize.width;
          const sel = selDrawing();
          c.save();
          for (const d of store[ctx.key] || []) drawOne(c, ctx, d, W, d === sel);
          if (draft && draft.key === ctx.key) drawOne(c, ctx, draft.d, W, false);
          if (ruler && ruler.ctx === ctx) drawRuler(c, ctx);
          c.restore();
        });
      },
    };
    const paneView = { zOrder: () => 'top', renderer: () => renderer };
    v.prim = {
      attached(p) { v.req = p.requestUpdate; },
      detached() { v.req = null; },
      updateAllViews() {
        // price-axis labels for horizontal lines/rays
        v.axis = [];
        const arr = (store[ctx.key] || []).slice();
        if (draft && draft.key === ctx.key) arr.push(draft.d);
        for (const d of arr) {
          if (d.type !== 'hline' && d.type !== 'hray') continue;
          const col = d.color || cfg['col' + cap(d.type)];
          const p = d.pts[0].p;
          v.axis.push({
            coordinate: () => ctx.series.priceToCoordinate(p) ?? -100,
            text: () => fmtP(ctx.key, p), textColor: () => '#0d0d0d', backColor: () => col,
            visible: () => true, tickVisible: () => true,
          });
        }
      },
      paneViews: () => [paneView],
      priceAxisViews: () => v.axis,
      hitTest(x, y) {
        if (tool) return { cursorStyle: 'crosshair', externalId: 'sbd-tool', zOrder: 'top' };
        const h = findHit(ctx, x, y);
        return h ? { cursorStyle: h.kind === 'pt' ? 'pointer' : 'move', externalId: 'sbd-' + h.d.id, zOrder: 'top' } : null;
      },
    };
    return v;
  }

  // ---------- interaction ----------
  const ctxOfEvent = e => {
    for (const v of views.values()) if (v.ctx.el.contains(e.target)) return v.ctx;
    return null;
  };
  const grab = e => { e.preventDefault(); e.stopPropagation(); suppressClick = true; };
  const finish = () => {
    const d = draft.d, key = draft.key;
    draft = null;
    d.pts = d.pts.map(pt => ({ t: Math.round(pt.t * 1000) / 1000, p: pt.p }));
    list(key).push(d);
    selected = { key, id: d.id };
    save();
    if (!cfg.keepTool) setTool(null);
    refresh(key);
    SB.emit('drawings', { key });
  };

  function onDown(ctx, e) {
    // only events on the chart canvas itself (not the header, focus button or our toolbar)
    if (!ctx.chart.chartElement().contains(e.target)) return;
    const m = local(ctx, e);
    if (!m.inside || !ctx.candles || !ctx.candles.length) return;
    const pos = fromXY(ctx, m.x, m.y, e.ctrlKey);
    if (!pos) return;
    // ruler: middle button, or Shift+LMB when no tool is active
    if (e.button === 1 || (e.button === 0 && e.shiftKey && !tool && !draft)) {
      grab(e);
      ruler = { ctx, a: pos, b: { ...pos } };
      startTrack(e);
      refresh(ctx.key);
      return;
    }
    if (e.button !== 0) return;
    if (draft) { // second click of a two-click placement
      grab(e);
      if (draft.key !== ctx.key) { draft = null; refresh(); return; }
      draft.d.pts[1] = pos;
      finish();
      return;
    }
    if (tool) {
      grab(e);
      const d = { id: newId(), type: tool, pts: [pos], color: cfg['col' + cap(tool)], width: cfg.width };
      if (tool === 'hline' || tool === 'hray') { draft = { key: ctx.key, d }; finish(); return; }
      d.pts.push({ ...pos });
      draft = { key: ctx.key, ctx, d, down: m, stage: 1 };
      startTrack(e);
      refresh(ctx.key);
      return;
    }
    const h = findHit(ctx, m.x, m.y);
    if (h) {
      grab(e);
      selected = { key: ctx.key, id: h.d.id };
      const lg = ctx.chart.timeScale().coordinateToLogical(m.x);
      drag = { ctx, key: ctx.key, d: h.d, kind: h.kind, idx: h.idx, start: { lg, p: pos.p, raw: ctx.series.coordinateToPrice(m.y) },
        orig: h.d.pts.map(pt => ({ ...pt })), moved: false };
      startTrack(e);
      refresh(ctx.key);
      return;
    }
    if (selected) { const k = selected.key; selected = null; refresh(k); }
  }

  let tracking = false;
  function startTrack() {
    if (tracking) return;
    tracking = true;
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }
  function stopTrack() {
    tracking = false;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
  }

  function onMove(e) {
    if (ruler) {
      const m = local(ruler.ctx, e);
      const p = fromXY(ruler.ctx, m.x, m.y, e.ctrlKey);
      if (p) { ruler.b = p; refresh(ruler.ctx.key); }
      return;
    }
    if (drag) {
      const { ctx, d } = drag;
      const m = local(ctx, e);
      if (d.type === 'pencil' && drag.kind === 'pt') drag.kind = 'body';
      if (drag.kind === 'pt') {
        const p = fromXY(ctx, m.x, m.y, e.ctrlKey);
        if (!p) return;
        if (d.type === 'hline') p.t = d.pts[0].t;
        d.pts[drag.idx] = p;
      } else {
        const lg = ctx.chart.timeScale().coordinateToLogical(m.x), pr = ctx.series.coordinateToPrice(m.y);
        if (lg == null || pr == null) return;
        const dl = lg - drag.start.lg, dp = pr - drag.start.raw;
        d.pts = drag.orig.map(pt => ({ t: d.type === 'hline' ? pt.t : l2t(ctx, t2l(ctx, pt.t) + dl), p: pt.p + dp }));
      }
      drag.moved = true;
      refresh(drag.key);
      return;
    }
    if (draft) {
      const ctx = draft.ctx && draft.ctx.key === draft.key ? draft.ctx : null;
      const over = ctxOfEvent(e);
      const c = over && over.key === draft.key ? over : ctx;
      if (!c) return;
      const m = local(c, e);
      if (draft.d.type === 'pencil') {
        const last = toXY(c, draft.d.pts[draft.d.pts.length - 1]);
        if (last && Math.hypot(last.x - m.x, last.y - m.y) < 2) return;
        const p = fromXY(c, m.x, m.y, false);
        if (p && draft.d.pts.length < 3000) draft.d.pts.push(p);
      } else {
        const p = fromXY(c, m.x, m.y, e.ctrlKey);
        if (p) draft.d.pts[1] = p;
      }
      refresh(draft.key);
    }
  }

  function onUp(e) {
    if (ruler) {
      const k = ruler.ctx.key;
      ruler = null;
      stopTrack();
      refresh(k);
      return;
    }
    if (drag) {
      const k = drag.key;
      if (drag.moved) { save(); SB.emit('drawings', { key: k }); }
      drag = null;
      stopTrack();
      refresh(k);
      return;
    }
    if (draft && draft.stage === 1) {
      if (draft.d.type === 'pencil') {
        stopTrack();
        if (draft.d.pts.length >= 2) finish(); else { draft = null; refresh(); }
        return;
      }
      const m = local(draft.ctx, e);
      if (Math.hypot(m.x - draft.down.x, m.y - draft.down.y) > 5) { stopTrack(); finish(); return; }
      draft.stage = 2; // keep tracking mousemove for the preview until the second click
    }
  }

  function cancel() {
    const had = !!(tool || draft || ruler || drag);
    if (drag) { drag.d.pts = drag.orig; drag = null; }
    draft = null; ruler = null;
    stopTrack();
    setTool(null);
    refresh();
    return had;
  }

  function setTool(t) {
    tool = t || null;
    if (draft && (!tool || draft.d.type !== tool)) { draft = null; stopTrack(); }
    for (const v of views.values()) {
      if (!v.bar) continue;
      for (const b of v.bar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
    }
    document.body.classList.toggle('sbd-tool-on', !!tool);
  }

  function removeDrawing(key, id) {
    const arr = store[key];
    if (!arr) return;
    const i = arr.findIndex(d => d.id === id);
    if (i >= 0) arr.splice(i, 1);
    if (selected && selected.id === id) selected = null;
    save(); refresh(key); SB.emit('drawings', { key });
  }
  function clearKey(key) {
    delete store[key];
    if (selected && selected.key === key) selected = null;
    save(); refresh(key); SB.emit('drawings', { key });
  }

  window.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Escape') {
      if (cancel()) { e.preventDefault(); e.stopImmediatePropagation(); }
      else if (selected) { const k = selected.key; selected = null; refresh(k); }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      removeDrawing(selected.key, selected.id);
    }
  }, true);
  // repaint the magnet preview when Ctrl changes mid-draft is not needed: next mousemove handles it

  // ---------- toolbar ----------
  const ICON = {
    trend: '<path d="M3 15L15 3"/><circle cx="3" cy="15" r="1.6"/><circle cx="15" cy="3" r="1.6"/>',
    hline: '<path d="M1 9H17"/>',
    hray: '<path d="M4 9H17"/><circle cx="4" cy="9" r="1.6"/>',
    rect: '<rect x="3" y="5" width="12" height="8"/>',
    fib: '<path d="M2 3H16M2 7H16M2 11H16M2 15H16"/>',
    pencil: '<path d="M3 15l1-4 8-8 3 3-8 8z"/>',
    trash: '<path d="M4 5h10M7 5V3h4v2M5 5l1 10h6l1-10"/>',
  };
  const svg = k => `<svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">${ICON[k]}</svg>`;
  function makeBar(ctx) {
    const bar = document.createElement('div');
    bar.className = 'sbd-bar';
    const hk = id => cfg['key' + cap(id)] ? ` (${cfg['key' + cap(id)].toUpperCase()})` : '';
    bar.innerHTML = TOOLS.map(([id, name]) => `<button data-tool="${id}" title="${name}${hk(id)}">${svg(id)}</button>`).join('') +
      `<button data-act="clear" title="Clear drawings of this coin">${svg('trash')}</button>`;
    const stop = e => { e.stopPropagation(); };
    bar.addEventListener('mousedown', stop);
    bar.addEventListener('contextmenu', stop);
    bar.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) setTool(tool === b.dataset.tool ? null : b.dataset.tool);
      else if (b.dataset.act === 'clear') {
        const n = (store[ctx.key] || []).length;
        if (!n) return;
        if (b.classList.contains('armed')) { clearKey(ctx.key); b.classList.remove('armed'); SB.ui.toast(`Removed ${n} drawings on ${ctx.key}`); }
        else { b.classList.add('armed'); b.title = 'Click again to clear'; setTimeout(() => { b.classList.remove('armed'); b.title = 'Clear drawings of this coin'; }, 2500); }
      }
    });
    for (const b of bar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
    return bar;
  }
  function placeBar(v) {
    const ctx = v.ctx;
    if (!v.bar) return;
    try {
      const er = ctx.el.getBoundingClientRect(), pr = paneRect(ctx);
      v.bar.style.top = (pr.top - er.top + 4) + 'px';
      v.bar.style.left = (pr.left - er.left + 4) + 'px';
    } catch (e) { /* chart not laid out yet */ }
  }

  // ---------- chart lifecycle ----------
  function attach(ctx) {
    if (views.has(ctx) || !ctx.series) return;
    const v = makeView(ctx);
    v.series = ctx.series;
    ctx.series.attachPrimitive(v.prim);
    views.set(ctx, v);
    const el = ctx.el;
    el.classList.add('sbd-host');
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    v.bar = makeBar(ctx);
    if (ctx.mode === 'focus') v.bar.classList.add('sbd-show');
    el.appendChild(v.bar);
    const down = e => onDown(ctx, e);
    const click = e => { if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); } };
    const enter = () => placeBar(v);
    const move = e => { if (draft && draft.stage === 2) onMove(e); };
    el.addEventListener('mousedown', down, true);
    el.addEventListener('click', click, true);
    el.addEventListener('auxclick', click, true);
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mousemove', move);
    setTimeout(() => placeBar(v), 50);
    v.cleanup = () => {
      el.removeEventListener('mousedown', down, true);
      el.removeEventListener('click', click, true);
      el.removeEventListener('auxclick', click, true);
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mousemove', move);
      if (v.bar) v.bar.remove();
      try { v.series.detachPrimitive(v.prim); } catch (e) { /* chart already removed */ }
    };
    if (ctx.onDestroy) ctx.onDestroy(() => detach(ctx));
  }
  function detach(ctx) {
    const v = views.get(ctx);
    if (!v) return;
    views.delete(ctx);
    if (draft && draft.ctx === ctx) draft.ctx = null;
    if (ruler && ruler.ctx === ctx) { ruler = null; stopTrack(); }
    if (drag && drag.ctx === ctx) { drag = null; stopTrack(); }
    v.cleanup();
  }

  // ---------- hotkeys ----------
  const bound = new Set();
  function bindKeys() {
    for (const [id] of TOOLS) {
      const combo = (cfg['key' + cap(id)] || '').toLowerCase();
      if (!combo || bound.has(combo)) continue;
      bound.add(combo);
      SB.hotkey(combo, () => {
        const t = TOOLS.find(([tid]) => (cfg['key' + cap(tid)] || '').toLowerCase() === combo);
        if (!t) return;
        setTool(tool === t[0] ? null : t[0]);
        return false;
      });
    }
  }

  // ---------- settings ----------
  function renderSettings(box) {
    const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    box.appendChild(h('div', 'dim', 'Click a hotkey field and press the new combo (Backspace clears). Hold Ctrl while drawing for the magnet; middle mouse or Shift+drag for the ruler.'));
    for (const [id, name] of TOOLS) {
      const k = 'key' + cap(id);
      const inp = SB.ui.field(box, name + ' hotkey', cfg, k, 'text');
      inp.readOnly = true;
      inp.placeholder = 'none';
      inp.addEventListener('keydown', e => {
        e.preventDefault(); e.stopPropagation();
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        const combo = (e.key === 'Backspace' || e.key === 'Delete') ? '' : SB.comboOf(e);
        if (combo === 'escape') return;
        cfg[k] = combo; inp.value = combo; SB.saveCfg(); bindKeys();
      });
    }
    for (const [id, name] of TOOLS) SB.ui.field(box, name + ' colour', cfg, 'col' + cap(id), 'color', { onChange: () => refresh() });
    SB.ui.field(box, 'Line width', cfg, 'width', 'select', { options: [1, 2, 3, 4], numeric: true });
    SB.ui.field(box, 'Fib levels', cfg, 'fibLevels', 'text', { wide: true, onChange: () => refresh() });
    SB.ui.field(box, 'Keep tool after drawing', cfg, 'keepTool', 'checkbox');

    const row = h('div', 'srow');
    row.appendChild(h('label', null, 'Clear drawings'));
    const sel = document.createElement('select');
    const fill = () => {
      sel.innerHTML = '';
      const keys = Object.keys(store).filter(k => store[k].length).sort();
      if (!keys.length) sel.appendChild(new Option('no drawings', ''));
      for (const k of keys) sel.appendChild(new Option(`${k} (${store[k].length})`, k));
      if (keys.length > 1) sel.appendChild(new Option('All coins', '*'));
    };
    fill();
    const btn = h('button', 'btn', 'Clear');
    btn.onclick = () => {
      const k = sel.value;
      if (!k) return;
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed'); btn.textContent = 'Sure?';
        setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Clear'; }, 2500);
        return;
      }
      btn.classList.remove('armed'); btn.textContent = 'Clear';
      if (k === '*') for (const key of Object.keys(store)) clearKey(key); else clearKey(k);
      fill();
    };
    row.appendChild(sel); row.appendChild(btn);
    box.appendChild(row);
  }

  // ---------- init ----------
  SB.init(() => {
    cfg = SB.defaults('drawings', {
      keyTrend: 'shift+s', keyHray: 'shift+d', keyHline: '', keyRect: '', keyFib: '', keyPencil: '',
      colTrend: '#e0e0e0', colHline: '#e0b84b', colHray: '#e0b84b', colRect: '#4b8bd2', colFib: '#999999', colPencil: '#f2f2f2',
      width: 1, fibLevels: '0,0.236,0.382,0.5,0.618,0.786,1', keepTool: false,
    });
    load();
    bindKeys();
    SB.on('chart:create', attach);
    SB.on('chart:destroy', detach);
    SB.on('chart:data', ctx => {
      const v = views.get(ctx);
      if (v && v.series !== ctx.series) { detach(ctx); attach(ctx); return; }
      if (!v) attach(ctx);
      if (draft && draft.ctx === ctx && draft.key !== ctx.key) { draft = null; stopTrack(); }
      refresh(ctx.key);
      if (v) placeBar(v);
    });
    if (SB.charts) for (const ctx of SB.charts) attach(ctx);
    window.addEventListener('storage', e => { if (e.key === LS_KEY) { load(); selected = null; refresh(); } });
    window.addEventListener('resize', () => { for (const v of views.values()) placeBar(v); });
    if (SB.ui && SB.ui.addSettings) SB.ui.addSettings({ id: 'drawings', title: 'Drawings', render: renderSettings });
  });

  // public API (tests, other modules)
  SB.drawings = {
    list: key => (store[key] || []).slice(),
    add(key, d) { d = Object.assign({ id: newId(), color: cfg['col' + cap(d.type)], width: cfg.width }, d); list(key).push(d); save(); refresh(key); return d.id; },
    remove: removeDrawing, clear: clearKey,
    setTool, get tool() { return tool; }, get selected() { return selected; },
    _views: views,
  };
})();
